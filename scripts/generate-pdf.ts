/**
 * PDF Generator - renders the PRE SVG evaluation template to PDF using Playwright.
 *
 * Usage:
 *   tsx scripts/generate-pdf.ts <data-json-path> <output-pdf-path>
 */

import { chromium } from "playwright";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, extname, resolve } from "path";

const [, , dataPath, outputPath] = process.argv;

if (!dataPath || !outputPath) {
  console.error("Usage: tsx scripts/generate-pdf.ts <data-json-path> <output-pdf-path>");
  process.exit(1);
}

type MonthlyProjection = {
  month: string;
  revenue: number;
  occupancy: number;
  adr: number;
};

type Projection = {
  revenue: number;
  occupancy: number;
  adr: number;
  monthly: MonthlyProjection[];
};

type EvaluationData = {
  address: string;
  mlsNumber: string;
  photos?: string[];
  hero?: {
    centerX?: number;
    centerY?: number;
    photoRadius?: number;
    frameInnerRadius?: number;
    frameOuterRadius?: number;
    zoom?: number;
  };
  projections: {
    high: Projection;
    medium: Projection;
    low: Projection;
  };
};

const data = JSON.parse(readFileSync(resolve(dataPath), "utf-8")) as EvaluationData;
const here = dirname(import.meta.url.replace("file://", ""));
const svgTemplatePath = resolve(here, "../templates/pre-elements/pre-template.svg");
let svg = readFileSync(svgTemplatePath, "utf-8").replace(/<\?xml[^>]*>\s*/u, "");

const fmtCurrency = (value: number) =>
  value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

const toDataUri = (filePath: string) => {
  const ext = extname(filePath).toLowerCase();
  const mimeByExt: Record<string, string> = {
    ".otf": "font/otf",
    ".ttf": "font/ttf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };
  const mime = mimeByExt[ext] || "application/octet-stream";
  return `data:${mime};base64,${readFileSync(filePath).toString("base64")}`;
};

const escapeXml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const replaceFirst = (input: string, pattern: RegExp, replacement: string) => {
  if (!pattern.test(input)) {
    throw new Error(`Pattern not found: ${pattern}`);
  }
  pattern.lastIndex = 0;
  return input.replace(pattern, replacement);
};

const buildFontCss = () => {
  const preDir = resolve(here, "../templates/pre-elements");
  const goodchildRegular = toDataUri(resolve(preDir, "Goodchild Pro Regular.otf"));
  const goodchildBold = toDataUri(resolve(preDir, "Goodchild Pro Bold.otf"));
  const montserratBold = toDataUri(resolve(preDir, "Montserrat-Bold.ttf"));

  return `
    @font-face {
      font-family: 'GoodchildPro';
      src: url('${goodchildRegular}') format('opentype');
      font-weight: 400;
      font-style: normal;
    }
    @font-face {
      font-family: 'GoodchildPro-Bold';
      src: url('${goodchildBold}') format('opentype');
      font-weight: 700;
      font-style: normal;
    }
    @font-face {
      font-family: 'Montserrat-Bold';
      src: url('${montserratBold}') format('truetype');
      font-weight: 700;
      font-style: normal;
    }
    html, body {
      margin: 0;
      width: 816px;
      height: 1056px;
      overflow: hidden;
      background: #121820;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    svg {
      display: block;
      width: 816px;
      height: 1056px;
    }
  `;
};

const findHeroPhoto = () => {
  const candidates: string[] = [];
  const configuredHero = (data.photos || [])[0];
  if (configuredHero) {
    candidates.push(resolve(configuredHero));
  }
  for (const ext of [".jpg", ".jpeg", ".png", ".webp"]) {
    candidates.push(resolve("data/images", data.mlsNumber || "", `photo-0${ext}`));
  }
  return candidates.find((candidate) => existsSync(candidate));
};

const getImageDimensions = (filePath: string): { w: number; h: number } => {
  // Read JPEG/PNG dimensions from file header
  const buf = readFileSync(filePath);
  const ext = extname(filePath).toLowerCase();
  if (ext === ".png") {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG: scan for SOF0/SOF2 marker
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] === 0xff && (buf[i + 1] === 0xc0 || buf[i + 1] === 0xc2)) {
      return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { w: 1, h: 1 }; // fallback
};

const buildHeroOverlay = () => {
  const heroPhoto = findHeroPhoto();
  const hero = data.hero || {};
  const centerX = hero.centerX ?? 306;
  const centerY = hero.centerY ?? 165;
  const photoRadius = hero.photoRadius ?? 55;
  const zoom = hero.zoom ?? 1.15;
  const focalX = hero.focalX ?? 0.5;
  const focalY = hero.focalY ?? 0.5;

  const defs = `
    <clipPath id="hero-photo-clip">
      <circle cx="${centerX}" cy="${centerY}" r="${photoRadius}" />
    </clipPath>
  `;

  if (heroPhoto) {
    const { w: imgW, h: imgH } = getImageDimensions(heroPhoto);
    const aspect = imgW / imgH;
    const viewDiameter = photoRadius * 2 * zoom;

    // Scale image to cover the circle (like object-fit: cover)
    let renderW: number, renderH: number;
    if (aspect > 1) {
      renderH = viewDiameter;
      renderW = viewDiameter * aspect;
    } else {
      renderW = viewDiameter;
      renderH = viewDiameter / aspect;
    }

    // Position so the focal point lands on the circle center
    const imageX = centerX - renderW * focalX;
    const imageY = centerY - renderH * focalY;

    // No frame circles drawn here — the background SVG/PNG already has the ring.
    // We just clip the photo into the existing frame.
    return {
      defs,
      markup: `
        <g id="dynamic-hero">
          <image
            x="${imageX.toFixed(2)}"
            y="${imageY.toFixed(2)}"
            width="${renderW.toFixed(2)}"
            height="${renderH.toFixed(2)}"
            preserveAspectRatio="none"
            clip-path="url(#hero-photo-clip)"
            xlink:href="${toDataUri(heroPhoto)}"
          />
        </g>
      `,
    };
  }

  return {
    defs,
    markup: `
      <g id="dynamic-hero">
        <circle cx="${centerX}" cy="${centerY}" r="${photoRadius}" fill="#31424e" />
        <text x="${centerX}" y="${centerY - 4}" text-anchor="middle" fill="#fbf9ea" font-family="GoodchildPro-Bold" font-size="9">NO PHOTO</text>
        <text x="${centerX}" y="${centerY + 8}" text-anchor="middle" fill="#fbf9ea" font-family="GoodchildPro-Bold" font-size="9">AVAILABLE</text>
      </g>
    `,
  };
};

const buildRevenueText = (x: number, y: number, value: number) =>
  `<text class="cls-3" transform="translate(${x} ${y})" text-anchor="middle"><tspan x="0" y="0">${escapeXml(
    fmtCurrency(value)
  )}</tspan></text>`;

const buildPropertyLine = (address: string) =>
  `<text class="cls-8" transform="translate(306 483.14)" text-anchor="middle"><tspan x="0" y="0">${escapeXml(
    `Property: ${address}`
  )}</tspan></text>`;

// Chart is now rendered via Chart.js in the browser — see buildChartPlaceholder and renderChartInBrowser
const CHART_SVG_X = 94;
const CHART_SVG_Y = 340;
const CHART_SVG_W = 420;
const CHART_SVG_H = 120;

const buildChartPlaceholder = () =>
  `<image id="chartjs-image" x="${CHART_SVG_X}" y="${CHART_SVG_Y}" width="${CHART_SVG_W}" height="${CHART_SVG_H}" />`;

const renderChartInBrowser = async (
  page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>>,
  monthly: MonthlyProjection[]
) => {
  const values = monthly.map((m) => m?.revenue || 0);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  await page.addScriptTag({ url: "https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js" });

  // Use page.evaluate with a string to avoid esbuild __name transform issues
  const dataUri = await page.evaluate(`(() => {
    const values = ${JSON.stringify(values)};
    const months = ${JSON.stringify(months)};
    const w = ${CHART_SVG_W};
    const h = ${CHART_SVG_H};

    const canvas = document.createElement("canvas");
    canvas.width = w * 2;
    canvas.height = h * 2;
    canvas.style.position = "fixed";
    canvas.style.left = "-9999px";
    document.body.appendChild(canvas);

    new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: {
        labels: months,
        datasets: [{
          data: values,
          backgroundColor: "rgba(251, 250, 232, 0.92)",
          borderColor: "rgba(251, 250, 232, 0.4)",
          borderWidth: 0.5,
          borderRadius: 2,
          barPercentage: 0.55,
          categoryPercentage: 0.8,
        }],
      },
      options: {
        responsive: false,
        animation: false,
        devicePixelRatio: 2,
        plugins: { legend: { display: false } },
        layout: { padding: { left: 4, right: 8, top: 6, bottom: 0 } },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              font: { size: 12, weight: "bold", family: "Arial" },
              color: "rgba(251, 250, 232, 0.85)",
              callback: function(v) { return v === 0 ? "0" : "$" + v.toLocaleString(); },
              maxTicksLimit: 6,
              padding: 6,
            },
            grid: {
              color: function(ctx) { return ctx.tick.value === 0 ? "rgba(251,250,232,0.9)" : "rgba(251,250,232,0.12)"; },
              lineWidth: function(ctx) { return ctx.tick.value === 0 ? 2.5 : 0.8; },
            },
            border: { display: false },
          },
          x: {
            ticks: {
              font: { size: 11, weight: "bold", family: "Arial" },
              color: "rgba(251, 250, 232, 0.8)",
              padding: 4,
            },
            grid: { display: false },
            border: { display: false },
          },
        },
      },
    });

    return canvas.toDataURL("image/png");
  })()`);

  return dataUri;
};

svg = replaceFirst(
  svg,
  /<text class="cls-3" transform="translate\(53\.15 285\.15\)"[\s\S]*?<\/text>/u,
  buildRevenueText(108.6, 285.15, data.projections.high.revenue)
);
svg = replaceFirst(
  svg,
  /<text class="cls-3" transform="translate\(250\.55 285\.15\)"[\s\S]*?<\/text>/u,
  buildRevenueText(306, 285.15, data.projections.medium.revenue)
);
svg = replaceFirst(
  svg,
  /<text class="cls-3" transform="translate\(447\.94 285\.15\)"[\s\S]*?<\/text>/u,
  buildRevenueText(503.4, 285.15, data.projections.low.revenue)
);

svg = replaceFirst(
  svg,
  /<text id="Lorem_ipsum_dolor_sittih_consectetur_adipisng_elittihsn_seddo_e-3"[\s\S]*?<\/text>/u,
  buildPropertyLine(data.address)
);

svg = replaceFirst(
  svg,
  /<text class="cls-6" transform="translate\(94\.31 351\.84\)"[\s\S]*?<\/text>/u,
  buildChartPlaceholder()
);
svg = svg.replace(/<text class="cls-(?:4|6)" transform="translate\((?:94\.35 388\.01|93\.57 369\.93|94\.28 406\.1|95\.59 424\.19|110\.81 442\.28)\)"[\s\S]*?<\/text>/gu, "");
// Remove all month labels from SVG template (Chart.js renders its own)
svg = svg.replace(/<text class="cls-\d+" transform="translate\([\d.]+ 449\.01\)"[\s\S]*?<\/text>/gu, "");
svg = replaceFirst(svg, /<g id="H2o9AC\.tif">[\s\S]*?<\/g>/u, "");

const heroOverlay = buildHeroOverlay();
svg = replaceFirst(svg, /<\/defs>/u, `${heroOverlay.defs}\n  </defs>`);
svg = replaceFirst(svg, /<\/svg>\s*$/u, `  ${heroOverlay.markup}\n</svg>`);

const html = `
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <title>Longitude Revenue Evaluation - ${escapeXml(data.address)}</title>
      <style>${buildFontCss()}</style>
    </head>
    <body>${svg}</body>
  </html>
`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 816, height: 1056 } });
await page.setContent(html, { waitUntil: "networkidle" });

// Render Chart.js in the browser, then inject the result into the SVG <image> element
const chartDataUri = await renderChartInBrowser(page, data.projections.medium.monthly || []);
await page.evaluate((uri) => {
  const img = document.getElementById("chartjs-image");
  if (img) img.setAttribute("href", uri);
}, chartDataUri);
await page.waitForTimeout(100);

const pdfBuffer = await page.pdf({
  width: "8.5in",
  height: "11in",
  printBackground: true,
  margin: { top: "0", right: "0", bottom: "0", left: "0" },
  pageRanges: "1",
});

writeFileSync(resolve(outputPath), pdfBuffer);
console.log(`PDF generated: ${outputPath}`);

await browser.close();
