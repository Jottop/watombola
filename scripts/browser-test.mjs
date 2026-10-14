/**
 * Prueba del overlay en un navegador REAL: renderiza de verdad, ejecuta la
 * animacion completa y captura cualquier error de consola o excepcion.
 *
 * Uso: astro build && node scripts/browser-test.mjs
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import puppeteer from 'puppeteer-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DIST = join(process.cwd(), 'dist');
const PORT = 4399;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  let file = join(DIST, normalize(url));
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) file = join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'shell',
  args: [
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--window-size=1920,1080',
  ],
});

const problems = [];
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });

// Interceptamos WebSocket antes de que corra el bundle para comprobar que mtmi
// intenta conectarse de verdad y no solo "carga sin error".
await page.evaluateOnNewDocument(() => {
  window.__sockets = [];
  const Native = window.WebSocket;
  window.WebSocket = function (...args) {
    window.__sockets.push({ url: String(args[0]), opened: false, closed: false });
    const sock = new Native(...args);
    const idx = window.__sockets.length - 1;
    sock.addEventListener('open', () => (window.__sockets[idx].opened = true));
    sock.addEventListener('close', () => (window.__sockets[idx].closed = true));
    return sock;
  };
  window.WebSocket.prototype = Native.prototype;
  Object.assign(window.WebSocket, Native);
});

page.on('console', (msg) => {
  const text = `${msg.type()}: ${msg.text()}`;
  if (msg.type() === 'error' || msg.type() === 'warning') problems.push(text);
});
page.on('pageerror', (err) => problems.push(`PAGEERROR: ${err.message}`));
page.on('requestfailed', (req) => problems.push(`REQFAIL: ${req.url()} ${req.failure()?.errorText}`));

const phase = () => page.evaluate(() => document.body.dataset.phase ?? '(idle)');

try {
  await page.goto(`http://localhost:${PORT}/overlay?bg=dark`, { waitUntil: 'networkidle0' });

  // Activamos Twitch ANTES de cargar para ejercitar el bundle de mtmi de
  // verdad: que importe, construya el WebSocket y conecte sin tirar.
  await page.evaluate(() => {
    localStorage.setItem(
      'tombola:twitch:v1',
      JSON.stringify({ enabled: true, channel: 'twitchpresents', command: '!entrar' }),
    );
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 6000));

  const sockets = await page.evaluate(() => window.__sockets);
  console.log(`websockets: ${JSON.stringify(sockets)}`);
  await page.screenshot({ path: join(process.cwd(), 'shots', '1-idle.png') });

  await page.keyboard.press('Space');
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`fase tras sortear: ${await phase()}`);
  await page.screenshot({ path: join(process.cwd(), 'shots', '2-spinning.png') });

  // esperar a la fase de eyecion
  for (let i = 0; i < 200; i++) {
    if ((await phase()) === 'ejecting') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`fase: ${await phase()}`);
  await page.screenshot({ path: join(process.cwd(), 'shots', '3-ejecting.png') });

  // esperar el reveal
  for (let i = 0; i < 200; i++) {
    if ((await phase()) === 'reveal') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 2500));
  console.log(`fase: ${await phase()}`);

  const state = await page.evaluate(() => ({
    winner: document.getElementById('winner-name')?.textContent,
    visible: document.getElementById('winner')?.classList.contains('is-visible'),
    draws: JSON.parse(localStorage.getItem('tombola:sorteos:v1') ?? '[]').length,
  }));
  console.log(`ganador: "${state.winner}" visible=${state.visible} sorteos=${state.draws}`);
  await page.screenshot({ path: join(process.cwd(), 'shots', '4-reveal.png') });

  await new Promise((r) => setTimeout(r, 3000));
  await page.screenshot({ path: join(process.cwd(), 'shots', '5-reveal-settled.png') });

  // reiniciar y volver a sortear
  await page.keyboard.press('r');
  await new Promise((r) => setTimeout(r, 800));
  await page.keyboard.press('Space');
  await new Promise((r) => setTimeout(r, 2000));
  console.log(`segundo sorteo, fase: ${await phase()}`);

  // Panel de control: que cargue y muestre las secciones nuevas.
  await page.goto(`http://localhost:${PORT}/control`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1200));
  const control = await page.evaluate(() => ({
    filas: document.querySelectorAll('#rows tr').length,
    twitch: document.getElementById('twitch-enabled')?.checked,
    canal: document.getElementById('twitch-channel')?.value,
    comando: document.getElementById('twitch-command')?.value,
    prueba: document.getElementById('test-data')?.checked,
  }));
  console.log(`control: ${JSON.stringify(control)}`);

  // Historial: borrar un registro suelto y borrar todo.
  const drawsState = () =>
    page.evaluate(() => ({
      filas: document.querySelectorAll('#draws tr').length,
      guardado: JSON.parse(localStorage.getItem('tombola:sorteos:v1') ?? '[]').length,
      vacio: !document.getElementById('no-draws').hidden,
    }));

  await page.evaluate(() => {
    // Un historial con 3 entradas para probar el borrado individual.
    const now = Date.now();
    localStorage.setItem(
      'tombola:sorteos:v1',
      JSON.stringify([
        { id: 'd1', participantId: 'twitch:1', name: 'Ana', drawnAt: now },
        { id: 'd2', participantId: 'twitch:2', name: 'Beto', drawnAt: now - 1000 },
        { id: 'd3', participantId: 'twitch:3', name: 'Caro', drawnAt: now - 2000 },
      ]),
    );
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));
  console.log(`historial inicial: ${JSON.stringify(await drawsState())}`);

  await page.evaluate(() =>
    document.querySelector('[data-remove-draw="d2"]').click(),
  );
  await new Promise((r) => setTimeout(r, 300));
  console.log(`tras quitar uno:  ${JSON.stringify(await drawsState())}`);

  await page.evaluate(() => document.getElementById('clear-draws').click());
  await new Promise((r) => setTimeout(r, 300));
  console.log(`tras borrar todo:  ${JSON.stringify(await drawsState())}`);

  await page.screenshot({ path: join(process.cwd(), 'shots', '6-control.png'), fullPage: true });

  // Interruptor de datos de prueba: tiene que sumar y sacar de la lista.
  const toggle = async (checked) => {
    await page.evaluate((want) => {
      const el = document.getElementById('test-data');
      el.checked = want;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, checked);
    await new Promise((r) => setTimeout(r, 400));
    return page.evaluate(() => ({
      filas: document.querySelectorAll('#rows tr').length,
      guardado: JSON.parse(localStorage.getItem('tombola:participantes:v1')).length,
      checkbox: document.getElementById('test-data').checked,
    }));
  };

  console.log(`desmarcar prueba: ${JSON.stringify(await toggle(false))}`);
  console.log(`marcar prueba:    ${JSON.stringify(await toggle(true))}`);
  console.log(`desmarcar otra vez: ${JSON.stringify(await toggle(false))}`);
  console.log(`marcar de nuevo:  ${JSON.stringify(await toggle(true))}`);

  // El overlay tiene que enterarse solo, sin recargar, por el evento storage.
  // Con ?ui la linea de estado dice cuantas bolas hay en el bombo.
  const ballsInOverlay = (tab) =>
    tab.evaluate(() => {
      const txt = document.getElementById('status')?.textContent ?? '';
      const match = txt.match(/(\d+)\s+(?:anotados|participantes)/);
      return match ? Number(match[1]) : null;
    });

  const overlayTab = await browser.newPage();
  await overlayTab.setViewport({ width: 1920, height: 1080 });
  await overlayTab.goto(`http://localhost:${PORT}/overlay?ui&bg=dark`, {
    waitUntil: 'networkidle0',
  });
  await new Promise((r) => setTimeout(r, 1500));

  const conDatos = await ballsInOverlay(overlayTab);
  await toggle(false);
  await new Promise((r) => setTimeout(r, 1200));
  const sinDatos = await ballsInOverlay(overlayTab);
  await toggle(true);
  await new Promise((r) => setTimeout(r, 1200));
  const vuelve = await ballsInOverlay(overlayTab);

  console.log(`overlay sin recargar: con datos=${conDatos} sin datos=${sinDatos} repuesto=${vuelve}`);
  await overlayTab.close();

  // Regresion: el overlay queda trabado en 'reveal' (no vuelve a idle hasta
  // que se reinicia). Antes, un cambio hecho desde el panel en ese momento se
  // guardaba para mas tarde y el bombo seguia mostrando la lista vieja.
  const stuckTab = await browser.newPage();
  await stuckTab.setViewport({ width: 1920, height: 1080 });
  await stuckTab.goto(`http://localhost:${PORT}/overlay?ui&bg=dark`, {
    waitUntil: 'networkidle0',
  });
  await new Promise((r) => setTimeout(r, 1200));

  await stuckTab.keyboard.press('Space');
  for (let i = 0; i < 300; i++) {
    if ((await stuckTab.evaluate(() => document.body.dataset.phase)) === 'reveal') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 1500));
  const faseAntes = await stuckTab.evaluate(() => document.body.dataset.phase);

  await toggle(false);
  await new Promise((r) => setTimeout(r, 2000));
  const vacioEnReveal = await ballsInOverlay(stuckTab);

  await toggle(true);
  await new Promise((r) => setTimeout(r, 2000));
  const repuestoEnReveal = await ballsInOverlay(stuckTab);

  console.log(
    `overlay en ${faseAntes}: bolas tras desmarcar=${vacioEnReveal} tras marcar=${repuestoEnReveal}`,
  );
  await stuckTab.screenshot({ path: join(process.cwd(), 'shots', '7-reveal-refill.png') });
  await stuckTab.close();

  // Red de seguridad: si el evento 'storage' no llega, el sondeo debe
  // converger igual. Escribimos directo en localStorage sin disparar evento.
  const pollTab = await browser.newPage();
  await pollTab.setViewport({ width: 1920, height: 1080 });
  await pollTab.goto(`http://localhost:${PORT}/overlay?ui&bg=dark`, {
    waitUntil: 'networkidle0',
  });
  await new Promise((r) => setTimeout(r, 1200));

  await page.evaluate(() => {
    const actual = JSON.parse(localStorage.getItem('tombola:participantes:v1') ?? '[]');
    localStorage.setItem('tombola:participantes:v1', JSON.stringify(actual.slice(0, 3)));
  });
  await new Promise((r) => setTimeout(r, 2500));
  const trasSondeo = await ballsInOverlay(pollTab);
  console.log(`sondeo sin evento storage: bolas=${trasSondeo} (esperado 3)`);
  if (trasSondeo !== 3) problems.push(`el sondeo no convergió: ${trasSondeo} bolas en vez de 3`);
  await pollTab.close();

  // Regresion: reiniciar con el confeti todavia en pantalla dejaba las
  // particulas congeladas en el canvas de efectos, porque al vaciarse
  // `active` pasaba a false y el frame ya no llamaba a draw().
  const confettiTab = await browser.newPage();
  await confettiTab.setViewport({ width: 1920, height: 1080 });
  await confettiTab.emulateMediaFeatures([
    { name: 'prefers-reduced-motion', value: 'no-preference' },
  ]);
  await confettiTab.goto(`http://localhost:${PORT}/overlay?bg=dark`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1200));

  const opacosEnFx = () =>
    confettiTab.evaluate(() => {
      const fx = document.getElementById('fx');
      const ctx = fx.getContext('2d');
      const data = ctx.getImageData(0, 0, fx.width, fx.height).data;
      let n = 0;
      for (let i = 3; i < data.length; i += 4 * 401) if (data[i] > 16) n++;
      return n;
    });

  await confettiTab.keyboard.press('Space');
  for (let i = 0; i < 300; i++) {
    if ((await confettiTab.evaluate(() => document.body.dataset.phase)) === 'reveal') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // onReveal dispara REVEAL_DURATION (0.9s) despues de entrar en reveal, asi
  // que hay que esperar a que el confeti efectivamente este en pantalla.
  await new Promise((r) => setTimeout(r, 2000));
  const duranteConfeti = await opacosEnFx();

  // Reinicio con el confeti todavia en pantalla.
  await confettiTab.keyboard.press('r');
  await new Promise((r) => setTimeout(r, 600));
  const trasReinicio = await opacosEnFx();

  await new Promise((r) => setTimeout(r, 2500));
  const trasEsperar = await opacosEnFx();

  console.log(
    `confeti: en pantalla=${duranteConfeti} tras reinicio=${trasReinicio} al terminar=${trasEsperar}`,
  );
  await confettiTab.screenshot({ path: join(process.cwd(), 'shots', '8-confeti-reset.png') });
  await confettiTab.close();

  if (duranteConfeti < 50) problems.push('no se genero confeti: la prueba no verifica nada');
  if (trasReinicio > 5) problems.push(`quedaron ${trasReinicio} particulas tras reiniciar`);
  if (trasEsperar > 5) problems.push(`quedaron ${trasEsperar} particulas sin confeti`);
} catch (err) {
  problems.push(`SCRIPT: ${err.message}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) {
  console.error(`\n${problems.length} PROBLEMAS:`);
  for (const p of [...new Set(problems)].slice(0, 15)) console.error('  ' + p);
  process.exit(1);
}
console.log('\nOK: sin errores de consola ni excepciones.');
