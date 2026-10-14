import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL = process.argv[2] ?? 'http://localhost:4321/overlay?bg=dark';

const problems = [];
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'shell',
  args: ['--no-sandbox', '--mute-audio'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`PAGEERROR: ${e.message}\n${e.stack ?? ''}`));
page.on('requestfailed', (r) =>
  problems.push(`REQFAIL: ${r.url()} ${r.failure()?.errorText}`),
);

try {
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 3000));

  const info = await page.evaluate(() => {
    const drum = document.getElementById('drum');
    const ctx = drum?.getContext('2d');
    const stored = localStorage.getItem('tombola:participantes:v1');
    return {
      canvas: drum ? `${drum.width}x${drum.height}` : 'NO EXISTE',
      stage: (() => {
        const s = document.getElementById('stage');
        return s ? `${s.clientWidth}x${s.clientHeight}` : 'NO EXISTE';
      })(),
      participantesGuardados: stored ? JSON.parse(stored).length : 'sin clave',
      pruebaActivada: localStorage.getItem('tombola:datosDePrueba:v1'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      // pixeles no transparentes del canvas: si el bombo se dibuja, hay color
      pixelesColoreados: ctx
        ? (() => {
            const d = ctx.getImageData(0, 0, drum.width, drum.height).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4 * 997) if (d[i] > 10) n++;
            return n;
          })()
        : 'sin ctx',
    };
  });

  console.log(JSON.stringify(info, null, 2));
  await page.screenshot({ path: join(process.cwd(), 'shots', 'diag-overlay.png') });
} catch (err) {
  problems.push(`SCRIPT: ${err.message}`);
} finally {
  await browser.close();
}

if (problems.length) {
  console.error('\nPROBLEMAS:');
  for (const p of [...new Set(problems)].slice(0, 10)) console.error('  ' + p);
} else {
  console.log('\nsin errores de consola');
}
