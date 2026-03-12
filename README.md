# releasing_website

A VitePress-based website workspace for ongoing content, feature, and style updates.

## Scripts

- `npm install`
- `npm run docs:dev`
- `npm run docs:build`
- `npm run docs:preview`

## Structure

- `docs/`: site content
- `docs/.vitepress/`: site config and theme overrides

## Notes

This project is intentionally set up as a flexible VitePress foundation so future changes can focus on content, UI refinements, and custom features without reworking the scaffolding.

## GitHub Pages

- Default branch: `main`
- Workflow: `.github/workflows/deploy.yml`
- Custom domain: `releasing.icu` via `docs/public/CNAME`

After creating the `releasing_website` repository on GitHub, push this project to `main`, then in repository settings enable GitHub Pages source as `GitHub Actions`.
