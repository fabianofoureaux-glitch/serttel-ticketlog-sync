'use strict';
// Sync do rastreador Getrak/QualySat -> Firestore (coleção veiculos).
// GitHub Actions + Playwright headless, de hora em hora. Não roda no Netlify
// (Lambda sem Chromium). Padrão de robustez espelhado do sync-chamados-cet.js:
// login/navegação com retry+backoff; se falhar, sai SEM sobrescrever dados válidos.

const admin = require('firebase-admin');
const { chromium } = require('playwright');

const svcAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(svcAccount) });
const db = admin.firestore();

const TAG = '[getrak]';
const BASE = 'https://sistema.getrak.com/qualysat';
const LOGIN_URL = BASE + '/';
const SUMARIO_URL = BASE + '/msumario/index/index';

// Normalização de placa idêntica dos dois lados do match: trim + upper + sem hífen/espaço.
function normPlaca(s) {
  return String(s || '').trim().toUpperCase().replace(/[\s-]/g, '');
}

// ── Geocoding do endereço do rastreador (texto -> lat/lng) via Nominatim/OSM ──
// O Getrak só expõe o endereço em texto; para o CET sugerir o veículo mais próximo
// precisamos de coordenadas. Geocodificamos aqui (Actions tem rede, sem CORS) e
// gravamos rastreadorLat/Lng no doc. Só refazemos quando o endereço muda
// (rastreadorGeoBase != endereço atual), respeitando o limite de ~1 req/s do Nominatim.
const NOMINATIM_UA = 'serttel-demandas-geocode/1.0 (fabianofoureaux@gmail.com)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function nominatim(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=br&q=' + encodeURIComponent(q);
  const r = await fetch(url, { headers: { 'User-Agent': NOMINATIM_UA, 'Accept-Language': 'pt-BR' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return j.length ? { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) } : null;
}

// Escada: endereço completo -> sem o número da casa (ex.: "7474F" quebra o Nominatim,
// mas rua+bairro+cidade resolve e cai no bairro certo). Retorna {lat,lng} ou null.
async function geocode(endereco) {
  let g = await nominatim(endereco);
  if (g) return g;
  await sleep(1100);
  const semNum = endereco.split(',').map(s => s.trim()).filter(s => !/^\d+[A-Za-z]?$/.test(s)).join(', ');
  if (semNum !== endereco) { g = await nominatim(semNum); if (g) return g; }
  return null;
}

// Retry com backoff (mesma escada do sync-chamados-cet.js): 3 tentativas, 3s e 8s.
async function withRetry(fn, label) {
  const delays = [3000, 8000];
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.log(`${TAG} ${label} tentativa ${attempt}/3 falhou: ${err.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, delays[attempt - 1]));
    }
  }
  throw lastErr;
}

// Preenche o primeiro seletor visível da lista (login tolerante a variações de nome).
async function fillFirst(page, selectors, value, label) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) && (await loc.isVisible().catch(() => false))) {
      await loc.fill(value);
      console.log(`${TAG} ${label} preenchido via ${sel}`);
      return;
    }
  }
  throw new Error(`campo ${label} não encontrado`);
}

async function login(page) {
  return withRetry(async () => {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await fillFirst(page, [
      'input[name="usuario"]', 'input[name="login"]', 'input[name="user"]',
      '#usuario', '#login', 'input[type="text"]',
    ], process.env.GETRAK_USER, 'usuario');
    await fillFirst(page, [
      'input[name="senha"]', 'input[name="password"]', '#senha', 'input[type="password"]',
    ], process.env.GETRAK_PASS, 'senha');

    const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("Entrar")').first();
    if (await submit.count()) await submit.click();
    else await page.keyboard.press('Enter');

    // Login OK quando o Sumário fica acessível (cards presentes). Se cair de volta
    // no form de senha, a navegação abaixo estoura timeout e o retry reprocessa.
    await page.goto(SUMARIO_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('li:has(span.outter)', { timeout: 45000 });
    console.log(`${TAG} login OK, sumário acessível`);
  }, 'login');
}

// O app JS às vezes congela; a cada tentativa recarrega e espera os cards renderizarem.
async function abrirSumario(page) {
  return withRetry(async () => {
    await page.goto(SUMARIO_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('li:has(span.outter)', { timeout: 45000 });
    const n = await page.locator('li:has(span.outter)').count();
    if (!n) throw new Error('nenhum card renderizado');
    console.log(`${TAG} sumário renderizado: ${n} cards`);
    return n;
  }, 'abrir_sumario');
}

// Extrai frente (placa/estado) e verso (endereço/última atualização) de cada card.
// Verso vem vazio; carrega ao clicar. Se o verso não carregar, mantém frente e segue.
async function extrairCards(page) {
  const cards = await page.$$('li:has(span.outter)');
  const out = [];
  for (const card of cards) {
    const placaEl = await card.$('span.placa');
    if (!placaEl) continue;
    const placaRaw = (await placaEl.innerText()).trim();
    if (!placaRaw) continue;
    const cls = (await placaEl.getAttribute('class')) || '';
    // 'desligado' contém 'ligado' como substring — testar desligado primeiro.
    const estado = /desligado/i.test(cls) ? 'Desligado' : /ligado/i.test(cls) ? 'Ligado' : null;

    let endereco = null, ultimaAtualizacao = null;
    try {
      await card.click();
      await page.waitForFunction(el => {
        const r = el.querySelector('.box-car p.reverso');
        return r && r.textContent.trim().length > 0;
      }, card, { timeout: 8000 });
      const back = await card.evaluate(el => {
        const box = el.querySelector('.box-car');
        const rev = box && box.querySelector('p.reverso');
        // Data/hora por regex sobre o texto do verso — robusto, sem depender de ícone.
        const texto = box ? box.textContent : '';
        const data = (texto.match(/\d{2}\/\d{2}\/\d{4}/) || [''])[0];
        const hora = (texto.match(/\d{2}:\d{2}:\d{2}/) || [''])[0];
        return { endereco: rev ? rev.textContent.trim() : '', data, hora };
      });
      endereco = back.endereco || null;
      ultimaAtualizacao = [back.data, back.hora].filter(Boolean).join(' ').trim() || null;
    } catch (e) {
      console.log(`${TAG} verso não carregou p/ ${placaRaw}: ${e.message}`);
    }

    out.push({ placaRaw, placaNorm: normPlaca(placaRaw), estado, endereco, ultimaAtualizacao });
  }
  return out;
}

async function main() {
  let browser;
  try {
    if (!process.env.GETRAK_USER || !process.env.GETRAK_PASS) {
      throw new Error('GETRAK_USER/GETRAK_PASS ausentes');
    }
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process'],
      headless: true,
    });
    const page = await (await browser.newContext()).newPage();

    await login(page);
    await abrirSumario(page);
    const cards = await extrairCards(page);

    // DEBUG TEMPORÁRIO — investigar mismatch de placa (remover depois).
    console.log(`${TAG} DEBUG placasRaw: ${JSON.stringify(cards.map(c => c.placaRaw))}`);
    try {
      const firstHtml = await page.$eval('li:has(span.outter)', el => el.outerHTML);
      console.log(`${TAG} DEBUG card[0] outerHTML: ${firstHtml.replace(/\s+/g, ' ').slice(0, 1200)}`);
    } catch (e) { console.log(`${TAG} DEBUG outerHTML falhou: ${e.message}`); }

    // Sanidade: contagem de estados (bater com o KPI "Comunicação dos veículos").
    const ligados = cards.filter(c => c.estado === 'Ligado').length;
    const desligados = cards.filter(c => c.estado === 'Desligado').length;
    console.log(`${TAG} extraídos ${cards.length} cards | ligados=${ligados} desligados=${desligados} sem-estado=${cards.length - ligados - desligados}`);
    const comAtu = cards.filter(c => c.ultimaAtualizacao).length;
    const exAtu = cards.find(c => c.ultimaAtualizacao);
    console.log(`${TAG} ultimaAtualizacao populada em ${comAtu}/${cards.length} | exemplo: ${exAtu ? exAtu.placaRaw + ' -> "' + exAtu.ultimaAtualizacao + '"' : 'nenhum'}`);
    if (!cards.length) throw new Error('scraping sem cards — abortando sem gravar');

    // Match por placa contra a coleção veiculos (todas as filiais). Guarda também os
    // dados atuais p/ decidir se precisa re-geocodificar (endereço mudou?).
    const vsnap = await db.collection('veiculos').get();
    const byPlaca = new Map();
    vsnap.forEach(d => {
      const p = normPlaca(d.data().placa);
      if (!p) return;
      if (!byPlaca.has(p)) byPlaca.set(p, []);
      byPlaca.get(p).push({ ref: d.ref, data: d.data() });
    });

    const now = admin.firestore.Timestamp.now();
    const batch = db.batch();
    let atualizados = 0, semPar = 0, geocodificados = 0, geoFalhas = 0;
    for (const c of cards) {
      const alvos = byPlaca.get(c.placaNorm);
      if (!alvos) { semPar++; continue; }
      // Só grava o que capturou — nunca sobrescreve com vazio (merge preserva o resto).
      const upd = { rastreadorSyncEm: now };
      if (c.estado) upd.rastreadorEstado = c.estado;
      if (c.endereco) upd.rastreadorEndereco = c.endereco;
      if (c.ultimaAtualizacao) upd.rastreadorUltimaAtualizacao = c.ultimaAtualizacao;

      // Geocodifica só quando há endereço novo e ele difere do que já foi geocodificado
      // (rastreadorGeoBase) OU ainda não há coordenada. Evita bater no Nominatim à toa.
      if (c.endereco) {
        const precisa = alvos.some(a =>
          a.data.rastreadorGeoBase !== c.endereco ||
          !Number.isFinite(Number(a.data.rastreadorLat)) ||
          !Number.isFinite(Number(a.data.rastreadorLng)));
        if (precisa) {
          try {
            const g = await geocode(c.endereco);
            if (g) {
              upd.rastreadorLat = g.lat;
              upd.rastreadorLng = g.lng;
              upd.rastreadorGeoBase = c.endereco;
              upd.rastreadorGeoEm = now;
              geocodificados++;
            } else {
              console.log(`${TAG} geocode sem resultado p/ ${c.placaRaw}: ${c.endereco}`);
              geoFalhas++;
            }
          } catch (e) {
            console.log(`${TAG} geocode erro p/ ${c.placaRaw}: ${e.message}`);
            geoFalhas++;
          }
          await sleep(1100);   // respeita ~1 req/s do Nominatim
        }
      }

      alvos.forEach(a => batch.set(a.ref, upd, { merge: true }));
      atualizados++;
    }
    await batch.commit();
    console.log(`${TAG} OK — atualizados=${atualizados} geocodificados=${geocodificados} geo-falhas=${geoFalhas} placas-sem-par-em-veiculos=${semPar}`);
  } finally {
    if (browser) await browser.close();
    await admin.app().delete();
  }
}

main().catch(e => {
  console.error(`${TAG} ERRO:`, String(e));
  process.exit(1);
});
