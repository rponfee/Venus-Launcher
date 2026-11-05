# Arte de Venus Points y niveles

Los cuatro PNG se generaron con la herramienta integrada de generación de imágenes de Codex, con fondo transparente. Se copiaron los originales, sin recomprimir ni retocar la transparencia, a `src/renderer/assets/venus/`:

- `points-ticket.png`: ticket de Venus Points (2.144.467 bytes).
- `planet-venus.png`: Venus (2.065.010 bytes).
- `planet-mars.png`: Marte (1.994.188 bytes).
- `planet-neptune.png`: Neptuno (1.546.312 bytes).

Los saldos, premios y niveles se dibujan como texto HTML traducible sobre el arte. Ningún número está dentro de la imagen. El editor de Venus Pass cambia planeta, marco, acento y color del número; `settings.passAppearance` se guarda en esta PC. No cambia XP, niveles ni premios. El número exige contraste AA sobre una placa oscura. El estilo se aplica al emblema y a las miniaturas de la pista. El ticket aparece en el saldo, los premios de puntos del pase y el acceso lateral.

## Prompts finales

### Ticket

Create one polished game UI currency collectible asset for Venus Launcher. A single horizontal futuristic admission ticket, aspect ratio of ticket silhouette roughly 2.3:1, centered isolated on a fully transparent background. Warm deep-space luxury, burnt orange metal, peach-copper foil, gold highlights, near-black burgundy inset panel, very small star engravings. Thick tactile bevel, restrained crisp pixel-art inspired ornamental cuts but smooth high quality illustrative rendering. Rounded clipped corners, circular ticket notches on both short sides, perforation line near right stub. Left third contains an embossed luminous Venus planet with warm atmospheric bands and a fine orbital line. The middle is a calm dark blank area designed for an HTML numeric balance to be overlaid later. Right stub has three small decorative stars. Front-facing near orthographic, absolutely no perspective skew. No text, no letters, no numbers, no logo words, no watermark, no background, no cast shadow outside object, no extra objects. Clear silhouette and readable down to 160 pixels wide. This is the production asset itself, not a mockup or screenshot.

### Venus

One production-ready isolated planet icon for a Venus Launcher game level badge: warm ivory and golden peach swirling dense cloud atmosphere, unmistakably Venus, copper gold rim. Single centered spherical planet fills about 80 percent of square composition. Polished hand painted 3D game collectible art, confident crisp silhouette, rich tactile detail visible at 140px, soft upper-left sunlight, lower-right shadow but beautiful legibility. Restrained golden space dust and three tiny four-point glints closely clustered by the outer silhouette, no large rings or large orbit. True transparent background, no outer card, no text, no numbers, no letters, no banner, no frame, no watermark, no extra planets. Whole sphere visible, no cropping. Leave middle region of planet calm enough for a real HTML level number overlay. A warm deep-space Venus gaming brand aesthetic, exquisite material, not a photograph, not a UI mockup.

### Marte y Neptuno

Se hizo una llamada por planeta usando este texto, sustituyendo `{look}` por la descripción indicada debajo:

A single isolated spherical planet icon for Venus Launcher level customisation: {look}. The sphere occupies 80 percent of a square composition and is fully visible, not cropped. Premium hand painted 3D game collectible art, crisp silhouette, tactile atmosphere or terrain readable at 140 pixels. Soft upper left sunlight, lower right shadow. Three tiny star glints tucked near the edge. Transparent background, absolutely no card or background scenery, no labels, no letters or numbers, no watermark, no other planets. Keep central region visually calm for overlaying a real level number using HTML later. Warm deep space gaming brand style. A production asset itself, not a UI mockup. Thin metallic accent around the sphere's silhouette only.

- Marte: rust red rocky Mars with dark terrain markings, ember copper edges and a small pale north polar cap
- Neptuno: deep blue and turquoise Neptune with delicate atmospheric bands and a soft dark storm, icy cyan edge light
