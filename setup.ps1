# agentdev setup — installs herdr FIRST (the required substrate), then the
# brain (pi extension + skills), then configures. Turnkey: clone -> .\setup.ps1 -> pi -> /agentdev on

Write-Host "== agentdev setup =="

# 1. herdr — required substrate, installed first (ARCHITECTURE.md §19)
if (Get-Command herdr -ErrorAction SilentlyContinue) {
  herdr --version
} else {
  Write-Host "herdr not found - installing (stable installer)..."
  irm https://herdr.dev/install.ps1 | iex
}
if (-not (Get-Command herdr -ErrorAction SilentlyContinue)) {
  Write-Error "ERROR: herdr install failed"
  exit 1
}

# 2. required tools (AC-INSTALL-2: herdr, pi, git, gh, node)
foreach ($tool in @("pi", "node", "npm", "git", "gh")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Write-Error "'$tool' not found - install it first (gh is required for direct-PR mode)."
    exit 1
  }
}

# 3. dependencies (npm ci: reproducible; --no-bin-links where chmod is restricted)
npm ci --no-bin-links --no-audit --no-fund

# 4. install the brain into pi (extension + skills, AC-INSTALL-1)
pi install ./ -l

# 5. sanity: unit suite
node node_modules/vitest/vitest.mjs run tests/unit
if ($LASTEXITCODE -ne 0) { Write-Error "unit tests failed - run 'npm test'"; exit 1 }

Write-Host ""
Write-Host "Done. Next steps:"
Write-Host "  pi"
Write-Host "  /agentdev on"
