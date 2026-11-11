// Developer-only icon export; shipped PNGs don't require Xcode or this script.
import { app, BrowserWindow } from "electron";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const assets = path.join(root, "desktop/assets");
const scratch = mkdtempSync(path.join(os.tmpdir(), "lupp-icon-export-"));
app.setPath("userData", path.join(scratch, "profile"));
const dataURL = async (file: string) => `data:image/png;base64,${(await readFile(file)).toString("base64")}`;
const writePNG = (file: string, url: string) => writeFile(file, Buffer.from(url.split(",")[1], "base64"));

async function build() {
  if (process.platform !== "darwin") throw new Error("Icon export requires macOS and Xcode's Icon Composer. Normal builds use the checked-in PNG.");
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL("about:blank");
  const source = await dataURL(path.join(assets, "lupp-icon-source.png"));
  // Preserve the existing artwork. Remove generated outer padding/alpha noise
  // and composite onto an opaque full-bleed background before native masking.
  const artwork: string = await window.webContents.executeJavaScript(`(async () => {
    const image = new Image(); image.src = ${JSON.stringify(source)}; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#faf3e8'; ctx.fillRect(0, 0, 1024, 1024);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 156, 146, 943, 947, 0, 0, 1024, 1024);
    return canvas.toDataURL('image/png');
  })()`);
  await writePNG(path.join(assets, "Lupp.icon/Assets/artwork.png"), artwork);
  const developer = (await exec("xcode-select", ["-p"])).stdout.trim();
  const ictool = path.resolve(developer, "../Applications/Icon Composer.app/Contents/Executables/ictool");
  const rendered = path.join(scratch, "rendered.png");
  await exec(ictool, [path.join(assets, "Lupp.icon"), "--export-preview", "macOS", "Light", "1024", "1024", "1", rendered]);
  const native = await dataURL(rendered);
  const output: { png: string; bounds: number[]; opaqueCenter: boolean; cleanMargin: boolean } = await window.webContents.executeJavaScript(`(async () => {
    const image = new Image(); image.src = ${JSON.stringify(native)}; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    // Flattened/legacy Dock export: 824px tile, 100px transparent margins.
    // This matches the 206px tile in Apple's installed 256px Notes icon.
    ctx.drawImage(image, 100, 100, 824, 824);
    const pixels = ctx.getImageData(0, 0, 1024, 1024).data;
    let minX=1024, minY=1024, maxX=-1, maxY=-1, cleanMargin=true, opaqueCenter=true;
    for (let y=0; y<1024; y++) for (let x=0; x<1024; x++) {
      const alpha = pixels[(y*1024+x)*4+3];
      if ((x<100 || x>=924 || y<100 || y>=924) && alpha!==0) cleanMargin=false;
      if (x>=350 && x<674 && y>=350 && y<674 && alpha!==255) opaqueCenter=false;
      if (alpha>=128) { minX=Math.min(minX,x); minY=Math.min(minY,y); maxX=Math.max(maxX,x); maxY=Math.max(maxY,y); }
    }
    return {png:canvas.toDataURL('image/png'), bounds:[minX,minY,maxX,maxY], opaqueCenter, cleanMargin};
  })()`);
  if (!output.opaqueCenter || !output.cleanMargin || output.bounds.join(",") !== "100,100,923,923") throw new Error(`Unexpected icon geometry: ${JSON.stringify({ ...output, png: undefined })}`);
  await writePNG(path.join(assets, "lupp-icon.png"), output.png);
  console.log("Exported 1024×1024 icon: native corners, 824×824 tile, opaque center, clean transparent margins.");
  window.destroy();
}

// Don't top-level-await app.whenReady(): Electron waits for its ESM entry point
// to finish loading before emitting ready.
void build().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await rm(scratch, { recursive: true, force: true });
  app.exit(Number(process.exitCode) || 0);
});
