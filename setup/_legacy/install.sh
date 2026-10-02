#!/bin/bash
# Job Agent Setup Script
# Run: bash setup/install.sh

set -e

echo ""
echo "============================================"
echo "  Job Agent — Setup Script"
echo "============================================"
echo ""

# Check Node.js version
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js is not installed."
  echo "Install from: https://nodejs.org (requires v18+)"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "ERROR: Node.js v18+ required. Current version: $(node -v)"
  echo "Update from: https://nodejs.org"
  exit 1
fi
echo "OK  Node.js $(node -v)"

# Check npm
if ! command -v npm &> /dev/null; then
  echo "ERROR: npm is not available"
  exit 1
fi
echo "OK  npm $(npm -v)"

# Check .env file
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo "CREATED  .env (copied from .env.example)"
    echo ""
    echo ">>> ACTION REQUIRED: Edit .env and fill in your keys before continuing <<<"
    echo ""
  else
    echo "WARNING: No .env or .env.example found"
  fi
else
  echo "OK  .env exists"
fi

# Install Playwright dependencies
echo ""
echo "Installing Playwright dependencies..."
cd playwright
npm install
echo "OK  npm install complete"

# Install Playwright browsers
echo ""
echo "Installing Playwright browsers (Chromium)..."
npx playwright install chromium
echo "OK  Chromium installed"
cd ..

# Create output directory
mkdir -p output
echo "OK  output/ directory created"

# Check n8n
echo ""
echo "Checking n8n..."
if curl -s --max-time 3 http://localhost:5678/healthz > /dev/null 2>&1; then
  echo "OK  n8n is running at http://localhost:5678"
else
  echo "WARNING: n8n is not running at localhost:5678"
  echo ""
  echo "To start n8n:"
  echo "  Option 1 (npx): npx n8n"
  echo "  Option 2 (global): npm install -g n8n && n8n start"
  echo "  Option 3 (Docker): docker run -it --rm --name n8n -p 5678:5678 n8nio/n8n"
  echo ""
  echo "Once n8n is running, import workflows from the n8n UI:"
  echo "  Settings > Import Workflow"
fi

echo ""
echo "============================================"
echo "  Setup Complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "1. Fill in .env with your API keys"
echo "2. Start n8n: npx n8n"
echo "3. Import workflows in this order:"
echo "   core/fit_scorer.json"
echo "   core/cv_builder.json"
echo "   core/app_logger.json"
echo "   agents/india_agent.json"
echo "   agents/abroad_agent.json"
echo "   agents/tier1_agent.json"
echo "   scrapers/linkedin_rss.json"
echo "   scrapers/naukri_scraper.json"
echo "   scrapers/indeed_scraper.json"
echo "   scrapers/wttj_scraper.json"
echo "   scrapers/tier1_scraper.json"
echo "4. Activate all workflows in n8n UI"
echo "5. Run: node setup/test_scorer.js"
echo ""
