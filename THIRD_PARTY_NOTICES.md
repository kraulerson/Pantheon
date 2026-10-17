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

---

## Lexend — console text face

- **Source:** https://github.com/googlefonts/lexend — commit `7894f02b2e7eabc48595f1d4eff3b17b48c6e651`
  (main, 2023-03-02), directory `fonts/lexend/webfonts/`; the fonts' name table reads
  `Version 1.008; ttfautohint (v1.8.4.7-5d5b)`.
- **What was copied:** two static WOFF2 instances, unmodified, into
  `services/control-plane/assets/fonts/`, served by the control-plane at `/assets/lexend-regular.woff2`
  and `/assets/lexend-semibold.woff2` for the Maestro Console page (no runtime request to Google Fonts;
  the asset route verifies these digests at startup):
  - `Lexend-Regular.woff2` — 37,180 bytes — SHA-256
    `dc9905cb55fde950de4e2c1c3240a9ece5ab7b3a7db8d8840322236705e0c017` — from
    https://raw.githubusercontent.com/googlefonts/lexend/7894f02b2e7eabc48595f1d4eff3b17b48c6e651/fonts/lexend/webfonts/Lexend-Regular.woff2
  - `Lexend-SemiBold.woff2` — 38,396 bytes — SHA-256
    `90341b5a4388f312327333c82fae2a9a3951e75f8f7e71568f25779fb6211a43` — from
    https://raw.githubusercontent.com/googlefonts/lexend/7894f02b2e7eabc48595f1d4eff3b17b48c6e651/fonts/lexend/webfonts/Lexend-SemiBold.woff2
- **Changes:** none (binary files vendored as published).
- **Licence:** SIL Open Font License 1.1 (`OFL.txt` at the same commit, SHA-256
  `5da8505887d0fa7fe963445fd58852707fda34adfeb65af25c99d152bab285bd`), reproduced verbatim below.

```
Copyright 2018 The Lexend Project Authors (https://github.com/googlefonts/lexend), with Reserved Font Name “RevReading Lexend”.

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
