#!/usr/bin/env bash
set -euo pipefail

main() {
  local version="${1:-latest}"
  if [[ "$version" == '--help' || "$version" == '-h' ]]; then
    printf 'Usage: bash install.sh [latest|VERSION]\nInstalls OmniSQL MCP under ~/.local/share/omnisql-mcp and ~/.local/bin.\nOverride with OMNISQL_INSTALL_DIR and OMNISQL_BIN_DIR.\n'
    return
  fi
  if [[ "$version" != 'latest' && ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]]; then
    printf 'Invalid version: %s\n' "$version" >&2
    return 1
  fi
  if [[ -z "${HOME:-}" ]]; then
    printf 'HOME must be set.\n' >&2
    return 1
  fi

  local install_dir="${OMNISQL_INSTALL_DIR:-$HOME/.local/share/omnisql-mcp}"
  local bin_dir="${OMNISQL_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$install_dir" "$bin_dir"
  install_dir="$(cd "$install_dir" && pwd)"
  bin_dir="$(cd "$bin_dir" && pwd)"
  local node_bin npm_bin

  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
    node_bin="$(command -v node)"
    npm_bin="$(command -v npm)"
  else
    command -v curl >/dev/null 2>&1 || { printf 'curl is required.\n' >&2; return 1; }
    command -v tar >/dev/null 2>&1 || { printf 'tar is required.\n' >&2; return 1; }
    local platform arch
    case "$(uname -s)" in
      Darwin) platform=darwin ;;
      Linux) platform=linux ;;
      *) printf 'Install Node.js 18+ and npm, then rerun this installer.\n' >&2; return 1 ;;
    esac
    case "$(uname -m)" in
      arm64|aarch64) arch=arm64 ;;
      x86_64|amd64) arch=x64 ;;
      *) printf 'Unsupported architecture. Install Node.js 18+ and npm first.\n' >&2; return 1 ;;
    esac
    local temp_dir archive expected actual
    OMNISQL_INSTALL_TEMP="$(mktemp -d)"
    temp_dir="$OMNISQL_INSTALL_TEMP"
    trap 'rm -rf -- "$OMNISQL_INSTALL_TEMP"' EXIT
    printf 'Installing a private Node.js 22 runtime...\n'
    curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$temp_dir/SHASUMS256.txt"
    archive="$(awk -v suffix="-$platform-$arch.tar.gz" '$2 ~ (suffix "$") {print $2; exit}' "$temp_dir/SHASUMS256.txt")"
    [[ -n "$archive" && "$archive" != */* ]] || { printf 'Node.js archive not found.\n' >&2; return 1; }
    expected="$(awk -v file="$archive" '$2 == file {print $1}' "$temp_dir/SHASUMS256.txt")"
    curl -fsSL "https://nodejs.org/dist/latest-v22.x/$archive" -o "$temp_dir/$archive"
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$temp_dir/$archive" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
      actual="$(shasum -a 256 "$temp_dir/$archive" | awk '{print $1}')"
    else
      printf 'sha256sum or shasum is required to verify Node.js.\n' >&2
      return 1
    fi
    [[ "$actual" == "$expected" ]] || { printf 'Node.js checksum mismatch.\n' >&2; return 1; }
    mkdir -p "$install_dir/runtime"
    tar -xzf "$temp_dir/$archive" -C "$install_dir/runtime" --strip-components=1
    node_bin="$install_dir/runtime/bin/node"
    npm_bin="$install_dir/runtime/bin/npm"
  fi

  printf 'Installing omnisql-mcp@%s...\n' "$version"
  PATH="$(dirname "$node_bin"):$PATH" "$npm_bin" install --prefix "$install_dir" --omit=dev --no-audit --no-fund "omnisql-mcp@$version"
  local launcher
  launcher="$(mktemp "$bin_dir/.omnisql-mcp.XXXXXX")"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'exec %q %q "$@"\n' "$node_bin" "$install_dir/node_modules/omnisql-mcp/dist/index.js"
  } > "$launcher"
  chmod +x "$launcher"
  mv -f "$launcher" "$bin_dir/omnisql-mcp"
  "$bin_dir/omnisql-mcp" --version
  printf '\nInstalled: %s/omnisql-mcp\nUse this absolute path as the command in your MCP client.\n' "$bin_dir"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) printf 'For terminal use, add this to your shell profile:\n  export PATH="%s:$PATH"\n' "$bin_dir" ;;
  esac
}

main "$@"
