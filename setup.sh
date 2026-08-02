#!/usr/bin/env bash
# agentdev setup — installs herdr FIRST (the required substrate), then the
# brain (pi extension + skills), then configures. Turnkey: clone → ./setup.sh → pi → /agentdev on
set -euo pipefail

echo "== agentdev setup =="

# 1. herdr — required substrate, installed first (ARCHITECTURE.md §19)
if command -v herdr >/dev/null 2>&1; then
  echo "herdr: $(herdr --version)"
else
  echo "herdr not found — installing (stable installer)..."
  curl -fsSL https://herdr.dev/install.sh | sh
fi
command -v herdr >/dev/null 2>&1 || { echo "ERROR: herdr install failed"; exit 1; }

# 2. required tools (AC-INSTALL-2: herdr, pi, git, gh, node)
for tool in pi node npm git gh; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: '$tool' not found — install it first (gh is required for direct-PR mode)."; exit 1; }
done

# 3. dependencies (npm ci: reproducible)
#    --no-bin-links is safe everywhere and REQUIRED on WSL /mnt/c (chmod is
#    not permitted on drvfs; scripts invoke vitest/tsc via node directly).
npm ci --no-bin-links --no-audit --no-fund

# 4. install the brain into pi (extension + skills, AC-INSTALL-1)
pi install ./ -l || pi install ./
command -v herdr >/dev/null 2>&1 || true

# 5. sanity: unit suite
if node node_modules/vitest/vitest.mjs run tests/unit >/dev/null 2>&1; then
  echo "unit tests: OK"
else
  echo "unit tests: FAILED — run 'npm test' for details"
  exit 1
fi

echo
echo "Done. Next steps:"
echo "  cd agentdev && pi"
echo "  /agentdev on"
echo
echo "NOTE: if 'pi' cannot find the extension after a fresh terminal,"
echo "      run 'pi install ./' once (writes project settings)."
