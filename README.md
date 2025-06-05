# Game Server – 2D Platform Shooter

A lightweight, authoritative server for a fast‑paced 2D platform shooter.  
Built with **TypeScript**, **Express**, and **Socket.io** for real‑time gameplay. 


---

## Tech Stack
| Purpose            | Library / Tool |
|--------------------|----------------|
| Web framework      | Express        |
| Networking (WS)    | Socket.io      |
| Language & build   | TypeScript, ts-node, tsc |
| Lint / format      | ESLint (Airbnb), Prettier |
| Testing            | Jest           |

---

## Quick Start

```bash
# 1. Install dependencies
pnpm install          # or npm / yarn

# 2. Copy env template and fill in values
cp .env.example .env

# 3. Run in dev mode (nodemon + ts-node)
pnpm dev              # or npm run dev

# 4. Build for production
pnpm build            # transpiles to dist/
node dist/index.js
