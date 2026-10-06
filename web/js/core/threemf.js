// 3MF writer for multi-colour printing: the bodies go in as parts of ONE object (3MF components),
// so slicers keep them aligned in their assembled positions and let each part take its own
// filament. As separate objects, slicers would drop every body onto the bed on its own.
// Note: Bambu Studio says "invalid config, load geometry data only" for any 3MF it didn't write
// itself; the geometry still loads (bambulab/BambuStudio#11927).
import { makeZip } from "./zip.js";

const esc = (s) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);

/** parts: [{ name, positions: Float32Array, indices: Uint32Array, color: "#rrggbb" }] -> Blob */
export function make3mf(parts, name = "Model") {
  const asm = parts.length + 2;   // id of the assembly object
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n',
    '<metadata name="Application">gpx2stl</metadata>\n',
    `<metadata name="Title">${esc(name)}</metadata>\n`,
    '<resources>\n<basematerials id="1">\n',
    ...parts.map((o) => `<base name="${esc(o.name)}" displaycolor="${o.color}" />\n`),
    "</basematerials>\n",
  ];
  parts.forEach((o, k) => {
    out.push(`<object id="${k + 2}" name="${esc(o.name)}" type="model" pid="1" pindex="${k}">\n<mesh>\n<vertices>\n`);
    const p = o.positions, v = [];
    for (let i = 0; i < p.length; i += 3) v.push(`<vertex x="${p[i].toFixed(4)}" y="${p[i + 1].toFixed(4)}" z="${p[i + 2].toFixed(4)}"/>`);
    out.push(v.join("\n"), "\n</vertices>\n<triangles>\n");
    const t = o.indices, tr = [];
    for (let i = 0; i < t.length; i += 3) tr.push(`<triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"/>`);
    out.push(tr.join("\n"), "\n</triangles>\n</mesh>\n</object>\n");
  });
  out.push(`<object id="${asm}" name="${esc(name)}" type="model">\n<components>\n`,
           ...parts.map((_, k) => `<component objectid="${k + 2}"/>\n`),
           "</components>\n</object>\n</resources>\n",
           `<build>\n<item objectid="${asm}"/>\n</build>\n</model>\n`);

  return makeZip([
    { name: "[Content_Types].xml", data:
      '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>' },
    { name: "_rels/.rels", data:
      '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
    { name: "3D/3dmodel.model", data: out.join("") },
  ], "model/3mf");
}
