#!/usr/bin/env bash
set -euo pipefail

main() {
  local version="${1:-latest}"
  if [[ "$version" == '--help' || "$version" == '-h' ]]; then
    printf 'Usage: bash install.sh [latest|VERSION]\nInstalls OmniSQL MCP with Bun under ~/.local/share/omnisql-mcp and ~/.local/bin.\nOverride with OMNISQL_INSTALL_DIR and OMNISQL_BIN_DIR.\n'
    return
  fi
  if [[ "$version" != 'latest' && ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]]; then
    printf 'Invalid version: %s\n' "$version" >&2
    return 1
  fi
  [[ -n "${HOME:-}" ]] || { printf 'HOME must be set.\n' >&2; return 1; }
  local install_dir="${OMNISQL_INSTALL_DIR:-$HOME/.local/share/omnisql-mcp}"
  local bin_dir="${OMNISQL_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$install_dir" "$bin_dir"
  install_dir="$(cd "$install_dir" && pwd)"
  bin_dir="$(cd "$bin_dir" && pwd)"
  local bun_bin
  if command -v bun >/dev/null 2>&1 &&
    bun -e 'process.exit(Bun.semver.satisfies(Bun.version, ">=1.4.3") ? 0 : 1)' >/dev/null 2>&1; then
    bun_bin="$(command -v bun)"
  else
    command -v curl >/dev/null 2>&1 || { printf 'curl is required.\n' >&2; return 1; }
    command -v unzip >/dev/null 2>&1 || { printf 'unzip is required.\n' >&2; return 1; }
    local platform arch
    case "$(uname -s)" in
      Darwin) platform=darwin ;;
      Linux) platform=linux ;;
      *) printf 'Install Bun 1.4.3+, then rerun this installer.\n' >&2; return 1 ;;
    esac
    case "$(uname -m)" in
      arm64|aarch64) arch=aarch64 ;;
      x86_64|amd64) arch=x64-baseline ;;
      *) printf 'Unsupported architecture. Install Bun 1.4.3+ first.\n' >&2; return 1 ;;
    esac
    if [[ "$platform" == linux ]] && ldd --version 2>&1 | grep -qi musl; then
      arch="${arch/x64-baseline/x64-musl-baseline}"
      [[ "$arch" != aarch64 ]] || arch=aarch64-musl
    fi
    local temp_dir archive expected actual runtime_dir
    OMNISQL_INSTALL_TEMP="$(mktemp -d)"
    temp_dir="$OMNISQL_INSTALL_TEMP"
    trap 'rm -rf -- "$OMNISQL_INSTALL_TEMP"' EXIT
    archive="bun-$platform-$arch.zip"
    printf 'Installing a private Bun 1.4.3 runtime...\n'
    curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 1 https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/SHASUMS256.txt -o "$temp_dir/SHASUMS256.txt"
    expected="$(awk -v file="$archive" '$2 == file || $2 == ("*" file) {print $1; exit}' "$temp_dir/SHASUMS256.txt")"
    [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || { printf 'Bun archive checksum not found.\n' >&2; return 1; }
    curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 1 "https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/$archive" -o "$temp_dir/$archive"
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$temp_dir/$archive" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
      actual="$(shasum -a 256 "$temp_dir/$archive" | awk '{print $1}')"
    else
      printf 'sha256sum or shasum is required to verify Bun.\n' >&2
      return 1
    fi
    [[ "$actual" == "$expected" ]] || { printf 'Bun checksum mismatch.\n' >&2; return 1; }
    unzip -q "$temp_dir/$archive" -d "$temp_dir"
    runtime_dir="$install_dir/runtime/bun-1.4.3"
    mkdir -p "$runtime_dir"
    cp "$temp_dir/${archive%.zip}/bun" "$runtime_dir/.bun-new"
    chmod +x "$runtime_dir/.bun-new"
    mv -f "$runtime_dir/.bun-new" "$runtime_dir/bun"
    bun_bin="$runtime_dir/bun"
  fi
  printf 'Installing omnisql-mcp@%s...\n' "$version"
  "$bun_bin" add --cwd "$install_dir" --no-cache --production --exact --ignore-scripts "omnisql-mcp@$version"
  local launcher
  launcher="$(mktemp "$bin_dir/.omnisql-mcp.XXXXXX")"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'exec %q %q "$@"\n' "$bun_bin" "$install_dir/node_modules/omnisql-mcp/dist/index.js"
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
