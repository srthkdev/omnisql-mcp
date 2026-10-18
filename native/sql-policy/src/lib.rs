#![forbid(unsafe_code)]
//! Syntax analysis only. Database roles and runtime policies provide authorization.
use serde::Serialize;
use sqlparser::ast::{Expr, ObjectName, Query, Select, Statement, TableFactor, Visit, Visitor};
use sqlparser::dialect::{
    ClickHouseDialect, Dialect, DuckDbDialect, GenericDialect, MsSqlDialect, MySqlDialect,
    PostgreSqlDialect, SQLiteDialect,
};
use sqlparser::parser::Parser;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::ops::ControlFlow;
use wasm_bindgen::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
struct NamePart {
    value: String,
    quoted: bool,
}
type Name = Vec<NamePart>;
fn name(value: &ObjectName) -> Name {
    value
        .0
        .iter()
        .map(|p| match p.as_ident() {
            Some(i) => NamePart {
                value: i.value.clone(),
                quoted: i.quote_style.is_some(),
            },
            None => NamePart {
                value: p.to_string(),
                quoted: true,
            },
        })
        .collect()
}
#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    operation: String,
    relations: BTreeSet<Name>,
    functions: BTreeSet<Name>,
    writes: bool,
    missing_predicate: bool,
    opaque_relations: bool,
    locking: bool,
    settings: bool,
}
#[derive(Default)]
struct Analyzer {
    oracle: bool,
    output: Analysis,
    scopes: Vec<HashSet<String>>,
    definition_scopes: HashMap<usize, HashSet<String>>,
}
impl Analyzer {
    fn key(&self, value: &str, quoted: bool) -> String {
        if quoted {
            value.into()
        } else if self.oracle {
            value.to_uppercase()
        } else {
            value.to_lowercase()
        }
    }
}
impl Visitor for Analyzer {
    type Break = ();
    fn pre_visit_query(&mut self, query: &Query) -> ControlFlow<()> {
        let mut scope = self
            .definition_scopes
            .remove(&(query as *const Query as usize))
            .unwrap_or_else(|| self.scopes.last().cloned().unwrap_or_default());
        if let Some(with) = &query.with {
            for cte in &with.cte_tables {
                let alias = self.key(&cte.alias.name.value, cte.alias.name.quote_style.is_some());
                // A non-recursive CTE cannot hide its own physical input relation.
                let mut definition = scope.clone();
                if with.recursive {
                    definition.insert(alias.clone());
                }
                self.definition_scopes
                    .insert(&*cte.query as *const Query as usize, definition);
                scope.insert(alias);
            }
        }
        self.scopes.push(scope);
        self.output.locking |= !query.locks.is_empty();
        self.output.settings |= query.settings.is_some() || query.format_clause.is_some();
        ControlFlow::Continue(())
    }
    fn post_visit_query(&mut self, _: &Query) -> ControlFlow<()> {
        self.scopes.pop();
        ControlFlow::Continue(())
    }
    fn pre_visit_relation(&mut self, relation: &ObjectName) -> ControlFlow<()> {
        let parts = name(relation);
        let cte = parts.len() == 1
            && self
                .scopes
                .last()
                .is_some_and(|s| s.contains(&self.key(&parts[0].value, parts[0].quoted)));
        if !cte {
            self.output.relations.insert(parts);
        }
        ControlFlow::Continue(())
    }
    fn pre_visit_table_factor(&mut self, factor: &TableFactor) -> ControlFlow<()> {
        match factor {
            TableFactor::Table {
                name: n,
                args: Some(_),
                ..
            }
            | TableFactor::Function { name: n, .. } => {
                self.output.functions.insert(name(n));
                self.output.opaque_relations = true;
            }
            TableFactor::Table { .. }
            | TableFactor::Derived { .. }
            | TableFactor::NestedJoin { .. } => {}
            _ => self.output.opaque_relations = true,
        }
        ControlFlow::Continue(())
    }
    fn pre_visit_expr(&mut self, expr: &Expr) -> ControlFlow<()> {
        if let Expr::Function(f) = expr {
            self.output.functions.insert(name(&f.name));
        }
        ControlFlow::Continue(())
    }
    fn pre_visit_select(&mut self, select: &Select) -> ControlFlow<()> {
        self.output.writes |= select.into.is_some();
        ControlFlow::Continue(())
    }
    fn pre_visit_statement(&mut self, statement: &Statement) -> ControlFlow<()> {
        match statement {
            Statement::Query(_) | Statement::Explain { .. } => {}
            Statement::Update(u) => {
                self.output.writes = true;
                self.output.missing_predicate |= u.selection.is_none();
            }
            Statement::Delete(d) => {
                self.output.writes = true;
                self.output.missing_predicate |= d.selection.is_none();
            }
            Statement::Drop { names, table, .. } => {
                self.output.writes = true;
                for n in names {
                    self.output.relations.insert(name(n));
                }
                if let Some(n) = table {
                    self.output.relations.insert(name(n));
                }
            }
            _ => self.output.writes = true,
        }
        ControlFlow::Continue(())
    }
}
fn parse(sql: &str, dialect: &dyn Dialect, oracle: bool) -> Result<Analysis, String> {
    if sql.len() > 1_000_000 {
        return Err("SQL exceeds the 1 MB limit".into());
    }
    let statements = Parser::new(dialect)
        .with_recursion_limit(64)
        .try_with_sql(sql)
        .map_err(|_| "SQL tokenization failed")?
        .parse_statements()
        .map_err(|_| "SQL syntax is unsupported or invalid")?;
    if statements.len() != 1 {
        return Err("Only a single SQL statement is allowed".into());
    }
    let mut analyzer = Analyzer {
        oracle,
        ..Analyzer::default()
    };
    analyzer.output.operation = match &statements[0] {
        Statement::Query(_) => "select".into(),
        Statement::Explain { .. } => "explain".into(),
        s => s
            .to_string()
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_lowercase(),
    };
    let _ = statements.visit(&mut analyzer);
    Ok(analyzer.output)
}
pub fn analyze(sql: &str, dialect: &str) -> Result<Analysis, String> {
    match dialect {
        "postgres" => parse(sql, &PostgreSqlDialect {}, false),
        "mysql" => parse(sql, &MySqlDialect {}, false),
        "mssql" => parse(sql, &MsSqlDialect {}, false),
        "sqlite" => parse(sql, &SQLiteDialect {}, false),
        "duckdb" => parse(sql, &DuckDbDialect {}, false),
        "clickhouse" => parse(sql, &ClickHouseDialect {}, false),
        "generic" => parse(sql, &GenericDialect {}, false),
        "oracle" => parse(sql, &GenericDialect {}, true),
        _ => Err("Unsupported SQL dialect".into()),
    }
}
#[wasm_bindgen]
pub fn analyze_sql(sql: &str, dialect: &str) -> Result<String, String> {
    analyze(sql, dialect).and_then(|a| serde_json::to_string(&a).map_err(|e| e.to_string()))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn relations(sql: &str) -> Vec<String> {
        analyze(sql, "postgres")
            .unwrap()
            .relations
            .iter()
            .map(|n| {
                n.iter()
                    .map(|p| p.value.clone())
                    .collect::<Vec<_>>()
                    .join(".")
            })
            .collect()
    }
    #[test]
    fn cte_sources_and_shadowing() {
        assert_eq!(
            relations("WITH report AS (SELECT * FROM public.orders) SELECT * FROM report"),
            ["public.orders"]
        );
        assert_eq!(
            relations("WITH orders AS (SELECT * FROM orders) SELECT * FROM orders"),
            ["orders"]
        );
        assert_eq!(
            relations(
                "WITH a AS (SELECT * FROM private.payroll), b AS (SELECT * FROM a) SELECT * FROM b"
            ),
            ["private.payroll"]
        );
    }
    #[test]
    fn nested_union_sources() {
        assert_eq!(
            relations(
                "SELECT * FROM public.a WHERE id IN (SELECT id FROM private.b) UNION SELECT * FROM public.c"
            ),
            ["private.b", "public.a", "public.c"]
        );
    }
    #[test]
    fn side_effects_and_predicates() {
        assert!(
            analyze(
                "WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone",
                "postgres"
            )
            .unwrap()
            .missing_predicate
        );
        assert!(
            analyze("SELECT * INTO copy FROM orders", "mssql")
                .unwrap()
                .writes
        );
        assert!(
            analyze("SELECT * FROM orders FOR UPDATE", "postgres")
                .unwrap()
                .locking
        );
        assert!(
            analyze("SELECT * FROM read_csv('/etc/passwd')", "duckdb")
                .unwrap()
                .opaque_relations
        );
    }
    #[test]
    fn one_statement_and_grammars() {
        assert!(analyze("SELECT 1; SELECT 2", "postgres").is_err());
        for d in [
            "postgres",
            "mysql",
            "mssql",
            "sqlite",
            "oracle",
            "duckdb",
            "clickhouse",
        ] {
            assert!(analyze("SELECT 1", d).is_ok());
        }
    }
}
