# vercel

Deploy and manage Vercel projects.

## CLI
- **Type:** prebuilt
- **Binary:** `vercel`
- **Install:** `npm i -g vercel`

## Auth
- **Required:** yes
- **Method:** token
- **Env:** `VERCEL_TOKEN`
- **Notes:** Run `vercel login` or set `VERCEL_TOKEN`

## Depends On
- git

## Commands
- `vercel --prod`
- `vercel` (preview deploy)
- `vercel ls`
- `vercel logs <url>`
- `vercel env pull`
