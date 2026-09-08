# Third-party notices

Code or content copied into this repository from another project is listed here with its licence
text, per the code-lifting rule in PROJECT_BIBLE.md §10 (ratified 2026-09-01). npm dependencies are
NOT listed: they are pulled at exact pinned versions and carry their licences in `node_modules`.
Each lifted file also carries a provenance header naming the source repository, commit, path,
licence, and what was changed.

---

## LibreChat — theme token values

- **Source:** https://github.com/danny-avila/LibreChat — tag `v0.8.7`, the built stylesheet
  (`client/src/style.css` design tokens).
- **What was copied:** the colour, font-stack and surface token *values* that make the harness
  match LibreChat's dark and light themes (`services/control-plane/src/http/theme.ts`,
  `HARNESS_THEME_CSS`). No component code, markup or scripts.
- **Changes:** re-expressed as our own CSS custom properties; xterm palette kept dark in both themes.
- **Licence:** MIT, reproduced verbatim below.

```
MIT License

Copyright (c) 2026 LibreChat

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
