import assert from 'node:assert/strict';

/** Exact values through the production MCP transport and native drivers. */
export async function checkValues({ engine, client, call, admin }) {
  const query = (text) => call(client, 'execute_query', { connectionId: 'fixture', query: text });
  const json =
    '{"id":9007199254740993,"decimal":123456789012345.6789,"nested":[9007199254740995],"small":1}';
  if (engine === 'mssql') {
    for (const type of ['DATETIME2(7)', 'TIME(7)', 'DATETIMEOFFSET(7)'])
      await assert.rejects(
        () =>
          query(
            `SELECT CAST('${type.startsWith('TIME(') ? '01:02:03.1234567' : type.startsWith('DATETIMEOFFSET') ? '2026-10-22T01:02:03.1234567+00:00' : '2026-10-22T01:02:03.1234567'}' AS ${type}) AS stamp`
          ),
        /timestamp exceeds exact millisecond driver precision[\s\S]*CAST/
      );
    assert.equal(
      (
        await query(
          "SELECT CONVERT(VARCHAR(40),CAST('2026-10-22T01:02:03.1234567' AS DATETIME2(7)),126) AS stamp"
        )
      ).rows[0][0],
      '2026-10-22T01:02:03.1234567'
    );
    assert.equal(
      (await query("SELECT CAST('2026-10-22T01:02:03.123' AS DATETIME2(3)) AS stamp")).rows[0][0],
      '2026-10-22T01:02:03.123Z'
    );
  } else if (engine === 'postgres') {
    const result = await query(
      `SELECT '${json}'::json AS a, '${json}'::jsonb AS b, (SELECT array_agg('${json}'::jsonb)) AS c`
    );
    const expected = {
      id: '9007199254740993',
      decimal: '123456789012345.6789',
      nested: ['9007199254740995'],
      small: 1,
    };
    assert.deepEqual(result.rows[0], [expected, expected, [expected]]);
    const typed = await query(
      "SELECT array_agg(123456789012345.6789::numeric), timestamp '2026-10-18 12:34:56.123456', date '2026-10-18' FROM (SELECT 1) fixture"
    );
    assert.deepEqual(typed.rows[0], [
      ['123456789012345.6789'],
      '2026-10-18 12:34:56.123456',
      '2026-10-18',
    ]);
  } else if (engine === 'mysql' || engine === 'mariadb') {
    const result = await query(
      "SELECT JSON_OBJECT('id',CAST(9007199254740993 AS UNSIGNED),'decimal',CAST(123456789012345.6789 AS DECIMAL(30,4)),'nested',JSON_ARRAY(CAST(9007199254740995 AS UNSIGNED)),'small',1) AS data"
    );
    const value = result.rows[0][0];
    if (typeof value === 'string') {
      // MariaDB can advertise JSON as ordinary text, which remains exact text.
      assert(value.includes('9007199254740993'));
      assert(value.includes('123456789012345.6789'));
    } else
      assert.deepEqual(value, {
        id: '9007199254740993',
        decimal: '123456789012345.6789',
        nested: ['9007199254740995'],
        small: 1,
      });
    assert.equal(
      (await query("SELECT CAST('2026-10-18 12:34:56.123456' AS DATETIME(6)) AS stamp")).rows[0][0],
      '2026-10-18 12:34:56.123456'
    );
  } else if (engine === 'oracle') {
    await assert.rejects(
      () =>
        query(
          "SELECT CAST(TIMESTAMP '2026-10-22 01:02:03.123456789' AS TIMESTAMP(9)) AS stamp FROM dual"
        ),
      /TO_CHAR/
    );
    assert.equal(
      (
        await query(
          "SELECT TO_CHAR(TIMESTAMP '2026-10-22 01:02:03.123456789','YYYY-MM-DD HH24:MI:SS.FF9') AS stamp FROM dual"
        )
      ).rows[0][0],
      '2026-10-22 01:02:03.123456789'
    );
    const result = await query(`SELECT JSON('${json}') AS data FROM dual`);
    assert.deepEqual(result.rows[0][0], {
      id: '9007199254740993',
      decimal: '123456789012345.6789',
      nested: ['9007199254740995'],
      small: 1,
    });
    assert.deepEqual(
      (await query("SELECT TO_CLOB('नमस्ते🙂'),TO_BLOB(HEXTORAW('CAFE00FF')) FROM dual")).rows[0],
      ['नमस्ते🙂', 'CAFE00FF']
    );
    const expression = "TO_CLOB(RPAD('a',3999,'a')) || TO_CLOB('🙂')";
    const expected = ('a'.repeat(3999) + '🙂').repeat(40);
    const long = await query(
      'SELECT ' + Array(40).fill(expression).join(' || ') + ' AS body FROM dual'
    );
    assert(long.resultId);
    assert.equal(long.clippedCells[0].length, expected.length);
    const readCell = async (resultId) => {
      const pieces = [];
      let offset = 0;
      do {
        const chunk = await call(client, 'read_result_cell', {
          resultId,
          row: 0,
          column: 0,
          offset,
        });
        assert(chunk.nextOffset === null || chunk.nextOffset > offset);
        pieces.push(chunk.text);
        offset = chunk.nextOffset;
      } while (offset !== null);
      return pieces.join('');
    };
    assert.equal(await readCell(long.resultId), expected);
    const document =
      "JSON_OBJECT('payload' VALUE (" +
      Array(40).fill(expression).join(' || ') +
      ') RETURNING JSON)';
    await assert.rejects(
      () => query('SELECT ' + document + ' AS data FROM dual'),
      /ORA-40478[\s\S]*RETURNING CLOB/
    );
    const serialized = await query(
      'SELECT JSON_SERIALIZE(' + document + ' RETURNING CLOB) AS data FROM dual'
    );
    const actual = JSON.parse(await readCell(serialized.resultId)).payload;
    const native = (
      await admin.query('SELECT JSON_SERIALIZE(' + document + ' RETURNING CLOB) AS data FROM dual')
    )[0].DATA;
    const reference = JSON.parse(await native.getData()).payload;
    native.destroy();
    assert.equal(actual === reference, true, 'OmniSQL must preserve the native serialized result');
    const asciiDocument =
      "JSON_OBJECT('payload' VALUE (" +
      Array(40).fill("TO_CLOB(RPAD('b',4000,'b'))").join(' || ') +
      ') RETURNING JSON)';
    const ascii = await query(
      'SELECT JSON_SERIALIZE(' + asciiDocument + ' RETURNING CLOB) AS data FROM dual'
    );
    assert.equal(
      JSON.parse(await readCell(ascii.resultId)).payload === 'b'.repeat(160000),
      true,
      'Large serialized JSON must survive result paging'
    );
    const giant = await query(
      'SELECT ' + Array(270).fill("TO_CLOB(RPAD('x',4000,'x'))").join(' || ') + ' AS body FROM dual'
    );
    assert.equal(giant.truncated, true);
    assert.equal(giant.limitReason, 'bytes');
    assert.equal(giant.rows.length, 0);
    assert.equal((await query('SELECT 1 FROM dual')).rows[0][0], '1');
  }
  console.log(`${engine}: exact JSON and native value checks passed`);
}
