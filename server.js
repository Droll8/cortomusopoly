// Server multiplayer Cortomusopoly
// Avvio: npm install (una volta sola), poi npm start
// Apri http://localhost:3000 in due tab del browser per testare

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
// Versione di gioco servita di default. Cambiala se vuoi tornare a versioni precedenti.
const DEFAULT_VERSION = '19.0';
const VERSIONS_DIR = path.join(__dirname, 'VERSIONI');
const AUDIO_DIR = __dirname; // Gli mp3 di sottofondo stanno nella root del progetto

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    // Più tolleranti per ridurre disconnessioni "random" su reti mobile/Wi-Fi instabili.
    // Valori aumentati rispetto alla configurazione precedente per gestire spike di latenza.
    pingInterval: 20000,   // ping ogni 20s (più frequente → rileva prima reti morte)
    pingTimeout: 90000,    // ma TOLLERA fino a 90s di silenzio prima di disconnettere (era 60s)
    transports: ['websocket', 'polling'],
    upgradeTimeout: 30000, // 30s per upgrade ws (lento su reti con proxy)
    // Permette al client di "ricongiungersi" mantenendo gli eventi persi durante una breve disconnessione
    connectionStateRecovery: {
        maxDisconnectionDuration: 3 * 60 * 1000, // 3 minuti (era 2)
        skipMiddlewares: true
    },
    // Permetti polling come fallback se WebSocket bloccato (alcune reti aziendali/proxy)
    allowEIO3: true,
    // Buffer più alto per evitare disconnect su payload grandi (es. snapshot stanza con molti giocatori)
    maxHttpBufferSize: 5 * 1024 * 1024 // 5 MB (default 1 MB)
});

// --- Error handlers globali: evitano che eccezioni non gestite uccidano il processo ---
process.on('uncaughtException', (err) => {
    console.error('!!! UNCAUGHT EXCEPTION (server vivo):', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
    console.error('!!! UNHANDLED PROMISE REJECTION (server vivo):', reason);
});

// --- Servizio file HTML ---
function serveVersion(version, res) {
    const filePath = path.join(VERSIONS_DIR, version + '.txt');
    fs.stat(filePath, (statErr, stat) => {
        if (statErr) {
            res.status(404).send(`<h1>Versione ${version} non trovata</h1><p>${statErr.message}</p>`);
            return;
        }
        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) {
                res.status(404).send(`<h1>Versione ${version} non trovata</h1><p>${err.message}</p>`);
                return;
            }
            // ETag dal mtime+size: cambia automaticamente quando il file è modificato
            const etag = `"v${version}-${stat.size}-${stat.mtimeMs}"`;
            // Se il client già ha la versione corrente in cache, rispondi 304 (zero bytes)
            if (req_headers_match(res, etag)) {
                res.status(304).end();
                return;
            }
            res.set({
                'Content-Type': 'text/html; charset=utf-8',
                // Cache 10 minuti + must-revalidate: il browser riusa il file locale per 10 min,
                // poi fa una HEAD con If-None-Match → server risponde 304 (200 bytes) se invariato.
                // Quando aggiorni il file, l'ETag cambia → il browser scarica il nuovo file.
                'Cache-Control': 'public, max-age=600, must-revalidate',
                'ETag': etag
            });
            res.send(data);
        });
    });
}
// Helper: legge If-None-Match dalla richiesta corrente (passata via res.req)
function req_headers_match(res, etag) {
    try {
        const inm = res.req && res.req.headers && res.req.headers['if-none-match'];
        return inm && inm === etag;
    } catch (e) { return false; }
}

app.get('/', (req, res) => serveVersion(DEFAULT_VERSION, res));
app.get('/v/:version', (req, res) => serveVersion(req.params.version, res));

// --- Healthcheck endpoint (keep-alive contro lo sleep di Render free tier) ---
// Il client effettua periodicamente GET /healthz mentre la pagina è aperta.
// Render conta le richieste HTTP come "attività" e non spegne il server.
app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
        ok: true,
        ts: Date.now(),
        rooms: Object.keys(rooms).length,
        version: DEFAULT_VERSION
    });
});

// --- Servizio audio (musica di sottofondo) ---
// Il file MP3 si trova nella root del progetto: lo serviamo con header che permettono
// streaming/seek e cache lato browser (l'utente può ricaricare senza ri-scaricare).
app.get('/audio/:filename', (req, res) => {
    const safeName = req.params.filename.replace(/[^a-zA-Z0-9._\- ]/g, '');
    if (!safeName) { res.status(400).send('bad filename'); return; }
    const filePath = path.join(AUDIO_DIR, safeName);
    fs.stat(filePath, (err, stat) => {
        if (err) { res.status(404).send('Audio non trovato: ' + safeName); return; }
        res.set({
            'Content-Type': 'audio/mpeg',
            'Content-Length': stat.size,
            'Accept-Ranges': 'bytes',
            // Cache aggressivo: 1 anno + immutable. I file MP3 non cambiano mai, quindi
            // il browser non li richiederà più al server per gli utenti già loggati una volta.
            // Riduzione bandwidth ~95% per gli utenti che tornano.
            'Cache-Control': 'public, max-age=31536000, immutable'
        });
        // Supporto Range per streaming/seek
        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            const chunkSize = (end - start) + 1;
            res.status(206).set({
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Content-Length': chunkSize
            });
            fs.createReadStream(filePath, { start, end }).pipe(res);
        } else {
            fs.createReadStream(filePath).pipe(res);
        }
    });
});

// --- Pool 100 nomi italiani inventati per squadre BOT (modalità con bot) ---
const BOT_TEAM_NAMES = [
    "Atletico Borgomonte", "Sporting Valnera", "Real Sant'Eligio", "Pol. Pievevecchia",
    "Olimpia Montemoro", "Virtus Castelporto", "Audace San Defendente", "AC Ponteforte",
    "US Roccaverde", "SS Vallecupa", "Sporting Boschereto", "Atletico Solcasso",
    "AC Arzago", "Frescoreno Calcio", "Cervariano FC", "Polisportiva Galmara",
    "Virtus Vergagno", "Real Mensano", "SS Pontelago", "Olimpia Trevazzio",
    "Bolizara 1923", "AC Pradibura", "Nodano FC", "Audace Cancavera",
    "Sporting Suestano", "Real Rovinello", "US Carcaroli", "Quartomare Calcio",
    "Cinquesoli FC", "Albacervo 1925", "Pol. Pinardo", "Atletico Ottoposto",
    "Virtus Trezzano", "AC Berenza", "SS Frascolo", "Salbiate FC",
    "Sporting Vinciago", "Real Calatone", "Olimpia Frenza", "Pievenuova Calcio",
    "Solferata FC", "Brevigna 1932", "Atletico Camporeale", "AC Montevarda",
    "US Forcalpina", "SS Vallediasso", "Sporting Brentora", "Real Maranola",
    "Pol. Sant'Anelio", "Olimpia Trecastra", "Virtus Pradoverde", "Audace Stellaria",
    "AC Castagnoldo", "Verascha FC", "Marbianco 1928", "Cintarosa Calcio",
    "Spelacchino FC", "Tornaverde Sportiva", "Atletico Vespraghino", "Boscofreddo FC",
    "AC Limonaia", "Pol. Vendisore", "Sporting Mareforte", "SS Trabolzano",
    "Real Cantosanto", "Audace Bivigne", "US Caraventa", "Olimpia Sgomberone",
    "Virtus Frangia", "Atletico Querceto", "AC Domenicano", "Spagliato 1924",
    "Pievelarga Calcio", "Sportiva Velenaria", "SS Borgolieto", "Real Tomareto",
    "Pol. Vellandra", "Olimpia Casalrioso", "Atletico Ponteceres", "Virtus Sansevera",
    "AC Lavernale", "Audace Marrigna", "US Roccavarda", "Sporting Nuvolovo",
    "Real Doniccia", "Sandolfino FC", "Atletico Frascomare", "SS Marchirla",
    "Pol. Saltocervo", "Virtus Trascarolo", "AC Settempio", "Castelfumo FC",
    "Olimpia Vagnasco", "Real Gravazzo", "Sporting Pielmonte", "Audace Crinaria",
    "AC Verdilume", "Stelladura 1929", "US Bramante", "Olimpia Valpresica",
    "Atletico Rivafonda", "Sporting Marrobbia", "AC Selvardo", "SS Pratomero"
];

const TARGET_TEAMS_TOTAL = 20;          // utenti + bot = 20 in modalità con bot
const MAX_MATCHDAYS = 38;               // partita finisce a 38 giornate

// Genera un risultato realistico per simulazione bot (capped a 4 gol per squadra)
function sampleGoalsForBot() {
    const r = Math.random();
    if (r < 0.35) return 0;
    if (r < 0.70) return 1;
    if (r < 0.88) return 2;
    if (r < 0.96) return 3;
    return 4;
}

function generateBotMatchResult() {
    return { own: sampleGoalsForBot(), opp: sampleGoalsForBot() };
}

// ============================================================================
// 19.0 — ECONOMIA: SPONSOR + MERCATO PACCHETTI
// ============================================================================

const INITIAL_CASH = 5_000_000;
const SPONSOR_SWAP_MIN_LAP_GAP = 10;
const PACK_PRICES = { 70: 3_000_000, 80: 10_000_000, 85: 22_000_000, 90: 45_000_000 };

// Catalogo statico dei 30 sponsor.
// `img` è vuoto per ora (l'utente le aggiungerà più avanti).
// Il payout è calcolato server-side da computeSponsorPayout(sponsorId, ctx).
const SPONSOR_CATALOG = [
    { id: 1,  name: 'Tradizionale',         desc: '500k fissi a giornata.',                                                                        img: '' },
    { id: 2,  name: 'Stipendio top',        desc: '900k fissi a giornata.',                                                                        img: '' },
    { id: 3,  name: 'Modesto',              desc: '200k fissi a giornata.',                                                                        img: '' },
    { id: 4,  name: 'Squadra di stelle',    desc: '400k + 100k per ogni giocatore in rosa con OVR ≥ 80.',                                          img: '' },
    { id: 5,  name: 'Marchio difensivo',    desc: '300k + 100k per ogni difensore con OVR ≥ 75.',                                                  img: '' },
    { id: 6,  name: 'Sponsor pazzo',        desc: 'Cifra random continua tra 100k e 1M ogni giornata.',                                            img: '' },
    { id: 7,  name: 'Premium giro',         desc: '200k base + 200k per ogni giro completato finora.',                                             img: '' },
    { id: 8,  name: 'Squadra equilibrata',  desc: '600k se la differenza tra OVR max e OVR min della rosa è ≤ 15, altrimenti 200k.',               img: '' },
    { id: 9,  name: 'Win bonus',            desc: '300k base + 500k se hai vinto la giornata precedente.',                                         img: '' },
    { id: 10, name: 'Tassa di sconfitta',   desc: '1M base − 400k per ogni sconfitta accumulata (cap a −2M).',                                     img: '' },
    { id: 11, name: 'Sponsor giovane',      desc: '250k + 50k per ogni giocatore con OVR ≤ 65.',                                                   img: '' },
    { id: 12, name: 'Cuore del gioco',      desc: '600k se hai ≥ 2 centrocampisti con OVR ≥ 75, altrimenti 200k.',                                  img: '' },
    { id: 13, name: 'Numero uno',           desc: '700k se il portiere ha OVR ≥ 80, altrimenti 300k.',                                              img: '' },
    { id: 14, name: 'Bomber d\'oro',        desc: '200k + 200k per ogni attaccante con OVR ≥ 80.',                                                  img: '' },
    { id: 15, name: 'Mura difensiva',       desc: '400k + 75k per ogni difensore con OVR ≥ 70.',                                                    img: '' },
    { id: 16, name: 'Striscia vincente',    desc: '300k + 200k per ogni vittoria consecutiva (si azzera con pareggio/sconfitta).',                  img: '' },
    { id: 17, name: 'Goleador',             desc: '100k + 100k per ogni gol segnato nella giornata precedente.',                                    img: '' },
    { id: 18, name: 'Porta inviolata',      desc: '300k base, +500k se nella giornata precedente non hai subito gol.',                              img: '' },
    { id: 19, name: 'Capolista',            desc: '1M se sei primo in classifica, altrimenti 200k.',                                                img: '' },
    { id: 20, name: 'Anti-blasone',         desc: '800k se sei ultimo in classifica, altrimenti 300k.',                                             img: '' },
    { id: 21, name: 'Sponsor estivo',       desc: '800k nelle giornate 1-19, 200k dalla 20 in poi.',                                                img: '' },
    { id: 22, name: 'Crescita',             desc: '200k nelle giornate 1-19, 800k dalla 20 in poi.',                                                img: '' },
    { id: 23, name: 'Sponsor lampo',        desc: '1M per 10 giornate dalla firma (anche dopo swap), poi 0.',                                       img: '' },
    { id: 24, name: 'Maratoneta',           desc: '400k base + 50k ogni 5 giornate completate.',                                                    img: '' },
    { id: 25, name: 'All in',               desc: '1M se hai vinto la giornata precedente, 0 altrimenti.',                                          img: '' },
    { id: 26, name: 'Scommettitore',        desc: 'Cifra random discreta uniforme tra {100k, 300k, 500k, 700k, 900k, 1.2M}.',                       img: '' },
    { id: 27, name: 'Equilibrato o niente', desc: 'Diff OVR max-min ≤ 10 → 800k, altrimenti 100k.',                                                img: '' },
    { id: 28, name: 'Patron',               desc: '500k base + 1M una tantum la prima volta che raggiungi il 1° posto.',                            img: '' },
    { id: 29, name: 'Risparmiatore',        desc: '300k base + 200k se hai ≥ 30M in cassa al momento del pagamento.',                               img: '' },
    { id: 30, name: 'Spendaccione',         desc: '400k base + 300k nella giornata immediatamente successiva all\'acquisto di un pacchetto.',       img: '' }
];

function getSponsorById(id) { return SPONSOR_CATALOG.find(s => s.id === id) || null; }

// Pesca 3 sponsor random non duplicati dal catalogo (uniforme 1/30)
function drawSponsorOptions(excludeIds = []) {
    const pool = SPONSOR_CATALOG.filter(s => !excludeIds.includes(s.id));
    const out = [];
    const cp = [...pool];
    for (let i = 0; i < 3 && cp.length > 0; i++) {
        const idx = Math.floor(Math.random() * cp.length);
        out.push(cp[idx].id);
        cp.splice(idx, 1);
    }
    return out;
}

// Ranking (1-based) di un socketId nella stanza considerando bot+utenti.
function getPlayerRank(room, socketId) {
    const entries = [];
    Object.keys(room.playerNamesById).forEach(id => {
        const s = room.standings[id] || {};
        const obj = typeof s === 'object' ? s : { pt: 0, gf: 0, gs: 0 };
        entries.push({ id, pt: obj.pt || 0, gf: obj.gf || 0, gs: obj.gs || 0 });
    });
    if (room.gameMode === 'withBots') {
        (room.bots || []).forEach(b => {
            const s = b.stats || {};
            entries.push({ id: b.id, pt: s.pt || 0, gf: s.gf || 0, gs: s.gs || 0 });
        });
    }
    entries.sort((a, b) => {
        if (b.pt !== a.pt) return b.pt - a.pt;
        const dra = a.gf - a.gs, drb = b.gf - b.gs;
        if (drb !== dra) return drb - dra;
        return b.gf - a.gf;
    });
    const idx = entries.findIndex(e => e.id === socketId);
    return { rank: idx >= 0 ? (idx + 1) : entries.length, total: entries.length };
}

// Helper: dato un payload di squad (server-side), conta giocatori che soddisfano un predicato.
// Per gli OVR usiamo l'OVR BASE del player (`p.ovr`).
function countSquadByPredicate(room, socketId, predicate) {
    const squad = room.squads[socketId] || {};
    let n = 0;
    Object.values(squad).forEach(p => {
        if (!p || typeof p !== 'object' || p.__specialists__ !== undefined) return;
        if (!p.identity) return;
        if (predicate(p)) n++;
    });
    return n;
}

function getSquadOvrSpread(room, socketId) {
    const squad = room.squads[socketId] || {};
    let min = Infinity, max = -Infinity;
    Object.values(squad).forEach(p => {
        if (!p || typeof p !== 'object' || p.__specialists__ !== undefined) return;
        if (!p.identity || typeof p.ovr !== 'number') return;
        if (p.ovr > max) max = p.ovr;
        if (p.ovr < min) min = p.ovr;
    });
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0, spread: 0 };
    return { min, max, spread: max - min };
}

// Stato economico per socketId, inizializzato lazy
function ensureEconomy(room, socketId) {
    if (!room.economy) room.economy = {};
    if (!room.economy[socketId]) {
        room.economy[socketId] = {
            cash: INITIAL_CASH,
            lastEarning: 0,
            sponsors: [null, null, null], // 3 slot: ciascuno { sponsorId, signedAtLap }
            // setup pendente: l'utente deve scegliere 3 sponsor uno alla volta.
            // pendingSetup = { slotIdx: 0|1|2, options: [3 sponsorIds] } | null
            pendingSetup: null,
            // Stato derivato per i payout
            winStreak: 0,                  // vittorie consecutive
            reachedFirstEver: false,       // sponsor #28 Patron
            lastPackBuyLap: -999,          // sponsor #30 Spendaccione: lap in cui ho comprato un pacchetto
            spendaccioneLapTriggered: -1,  // lap su cui ho già accreditato il bonus +300k (per non darlo 2 volte)
            lastSeenLap: 0                 // ultimo lap per cui ho pagato (anti-double-payment)
        };
    }
    return room.economy[socketId];
}

// Avvia il setup sponsor: piazza la prima triade di opzioni nello slot 0
function startSponsorSetup(room, socketId) {
    const e = ensureEconomy(room, socketId);
    if (e.sponsors.every(s => s)) return; // già completati
    // Trova il primo slot non occupato
    const slotIdx = e.sponsors.findIndex(s => !s);
    if (slotIdx < 0) return;
    e.pendingSetup = {
        slotIdx,
        options: drawSponsorOptions(e.sponsors.filter(Boolean).map(s => s.sponsorId))
    };
}

// Calcola il payout di un singolo sponsor in un contesto specifico
function computeSponsorPayout(sponsorId, ctx) {
    // ctx = {
    //   room, socketId, lap, prevMatch: {own, opp, points, verdict}|null,
    //   rankInfo: {rank, total}, winStreak, lastPackBuyLap, reachedFirstEver,
    //   currentCash, signedAtLap
    // }
    const { room, socketId, lap, prevMatch, rankInfo, winStreak, lastPackBuyLap, reachedFirstEver, currentCash, signedAtLap } = ctx;
    switch (sponsorId) {
        case 1: return 500_000;
        case 2: return 900_000;
        case 3: return 200_000;
        case 4: {
            const n = countSquadByPredicate(room, socketId, p => (p.ovr || 0) >= 80);
            return 400_000 + 100_000 * n;
        }
        case 5: {
            const n = countSquadByPredicate(room, socketId, p => p.role === 'dif' && (p.ovr || 0) >= 75);
            return 300_000 + 100_000 * n;
        }
        case 6: {
            // Random continuo 100k-1M
            return Math.floor(100_000 + Math.random() * 900_001);
        }
        case 7: {
            const giri = Math.max(0, lap);
            return 200_000 + 200_000 * giri;
        }
        case 8: {
            const spread = getSquadOvrSpread(room, socketId).spread;
            return spread <= 15 ? 600_000 : 200_000;
        }
        case 9: {
            const wonPrev = prevMatch && prevMatch.verdict === 'W';
            return 300_000 + (wonPrev ? 500_000 : 0);
        }
        case 10: {
            const losses = (room.standings[socketId] && room.standings[socketId].l) || 0;
            const malus = Math.min(2_000_000, 400_000 * losses);
            return 1_000_000 - malus;
        }
        case 11: {
            const n = countSquadByPredicate(room, socketId, p => (p.ovr || 0) <= 65);
            return 250_000 + 50_000 * n;
        }
        case 12: {
            const n = countSquadByPredicate(room, socketId, p => p.role === 'cen' && (p.ovr || 0) >= 75);
            return n >= 2 ? 600_000 : 200_000;
        }
        case 13: {
            const squad = room.squads[socketId] || {};
            const por = Object.values(squad).find(p => p && p.role === 'por' && p.identity);
            const ovr = por ? (por.ovr || 0) : 0;
            return ovr >= 80 ? 700_000 : 300_000;
        }
        case 14: {
            const n = countSquadByPredicate(room, socketId, p => p.role === 'att' && (p.ovr || 0) >= 80);
            return 200_000 + 200_000 * n;
        }
        case 15: {
            const n = countSquadByPredicate(room, socketId, p => p.role === 'dif' && (p.ovr || 0) >= 70);
            return 400_000 + 75_000 * n;
        }
        case 16: return 300_000 + 200_000 * (winStreak || 0);
        case 17: {
            const goals = prevMatch ? (prevMatch.own || 0) : 0;
            return 100_000 + 100_000 * goals;
        }
        case 18: {
            const cleanSheet = prevMatch && (prevMatch.opp || 0) === 0;
            return 300_000 + (cleanSheet ? 500_000 : 0);
        }
        case 19: return (rankInfo.rank === 1) ? 1_000_000 : 200_000;
        case 20: return (rankInfo.rank === rankInfo.total && rankInfo.total > 0) ? 800_000 : 300_000;
        case 21: return (lap <= 19) ? 800_000 : 200_000;
        case 22: return (lap <= 19) ? 200_000 : 800_000;
        case 23: {
            // 1M per 10 giornate dalla firma. Il "lap" è quello al momento del pagamento
            // (paghiamo lap_corrente). La firma è signedAtLap.
            const elapsed = lap - signedAtLap;
            return (elapsed >= 0 && elapsed < 10) ? 1_000_000 : 0;
        }
        case 24: {
            const bonus = Math.floor(lap / 5) * 50_000;
            return 400_000 + bonus;
        }
        case 25: return (prevMatch && prevMatch.verdict === 'W') ? 1_000_000 : 0;
        case 26: {
            const opts = [100_000, 300_000, 500_000, 700_000, 900_000, 1_200_000];
            return opts[Math.floor(Math.random() * opts.length)];
        }
        case 27: {
            const spread = getSquadOvrSpread(room, socketId).spread;
            return spread <= 10 ? 800_000 : 100_000;
        }
        case 28: {
            // 500k base + 1M una tantum quando raggiungi il 1° posto la prima volta
            let amount = 500_000;
            if (!reachedFirstEver && rankInfo.rank === 1) amount += 1_000_000;
            return amount;
        }
        case 29: {
            const bonus = currentCash >= 30_000_000 ? 200_000 : 0;
            return 300_000 + bonus;
        }
        case 30: {
            // +300k SOLO il giorno IMMEDIATAMENTE successivo all'acquisto di un pacchetto.
            // lastPackBuyLap = lap in cui hai comprato; il bonus arriva al lap successivo (lap === lastPackBuyLap + 1)
            const bonus = (lastPackBuyLap >= 0 && lap === lastPackBuyLap + 1) ? 300_000 : 0;
            return 400_000 + bonus;
        }
        default: return 0;
    }
}

// Applica i pagamenti sponsor a fine di una giornata (chiamata da match-result handler).
// Aggiorna: cash, lastEarning, winStreak, reachedFirstEver, lastSeenLap.
function applySponsorPaymentsForLap(room, socketId, prevMatch, currentLap) {
    const e = ensureEconomy(room, socketId);
    // Anti-double-payment: se ho già pagato per questo lap, esco.
    if (e.lastSeenLap >= currentLap) return null;
    // Aggiorno winStreak in base al match appena giocato
    if (prevMatch && prevMatch.verdict === 'W') {
        e.winStreak = (e.winStreak || 0) + 1;
    } else if (prevMatch) {
        e.winStreak = 0;
    }
    const rankInfo = getPlayerRank(room, socketId);
    // Patron "una tantum" — flagged PRIMA di calcolare cosi non si triplica se ho 2 patron (non possibile, ma safety)
    const wasFirstBefore = e.reachedFirstEver;
    // Calcolo le 3 cifre
    let total = 0;
    const breakdown = [];
    e.sponsors.forEach((slot, idx) => {
        if (!slot) { breakdown.push({ slotIdx: idx, sponsorId: null, amount: 0 }); return; }
        const ctx = {
            room, socketId,
            lap: currentLap,
            prevMatch,
            rankInfo,
            winStreak: e.winStreak,
            lastPackBuyLap: e.lastPackBuyLap,
            reachedFirstEver: e.reachedFirstEver,
            currentCash: e.cash,
            signedAtLap: slot.signedAtLap || 0
        };
        const amount = computeSponsorPayout(slot.sponsorId, ctx);
        total += amount;
        breakdown.push({ slotIdx: idx, sponsorId: slot.sponsorId, amount });
        // Patron: flagga il "primo posto raggiunto"
        if (slot.sponsorId === 28 && !wasFirstBefore && rankInfo.rank === 1) {
            e.reachedFirstEver = true;
        }
    });
    e.cash = Math.max(0, e.cash + total);
    e.lastEarning = total;
    e.lastSeenLap = currentLap;
    return { total, breakdown, cashAfter: e.cash };
}

// Helper: pulisci sponsor state quando un giocatore lascia (cleanup completo). Chiamato da disconnect grace.
function cleanupEconomy(room, socketId) {
    if (room.economy) delete room.economy[socketId];
}

function pickRandomBotNames(count, exclude = []) {
    const used = new Set(exclude);
    const pool = BOT_TEAM_NAMES.filter(n => !used.has(n));
    // Shuffle Fisher-Yates
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count);
}

function emptyStats() {
    return { pt: 0, w: 0, d: 0, l: 0, gf: 0, gs: 0, played: 0 };
}

function ensureUserStats(room, socketId) {
    if (!room.standings[socketId] || typeof room.standings[socketId] !== 'object') {
        room.standings[socketId] = emptyStats();
    }
    return room.standings[socketId];
}

// Trova il numero massimo di giornate giocate fra TUTTI gli utenti correnti
function maxUserPlayed(room) {
    let max = 0;
    Object.keys(room.playerNamesById).forEach(id => {
        const s = room.standings[id];
        if (s && typeof s === 'object' && (s.played || 0) > max) max = s.played;
    });
    return max;
}

// Simula UNA giornata per ogni bot ancora attivo (cap 38 totali)
function simulateBotsMatchday(room) {
    if (room.botMatchdaysSimulated >= MAX_MATCHDAYS) return;
    if (!room.botMatchHistoryById) room.botMatchHistoryById = {};
    for (const bot of room.bots) {
        const r = generateBotMatchResult();
        bot.stats.played++;
        bot.stats.gf += r.own;
        bot.stats.gs += r.opp;
        let points;
        if (r.own > r.opp) { points = 3; bot.stats.pt += 3; bot.stats.w++; }
        else if (r.own === r.opp) { points = 1; bot.stats.pt += 1; bot.stats.d++; }
        else { points = 0; bot.stats.l++; }
        // Storico bot: ogni match simulato come entry
        if (!room.botMatchHistoryById[bot.id]) room.botMatchHistoryById[bot.id] = [];
        room.botMatchHistoryById[bot.id].push({
            own: r.own, opp: r.opp, points,
            verdict: points === 3 ? 'W' : (points === 1 ? 'D' : 'L'),
            oppName: '—',
            matchday: bot.stats.played
        });
    }
    room.botMatchdaysSimulated++;
    console.log(`[bots] simulata giornata ${room.botMatchdaysSimulated}/${MAX_MATCHDAYS} per ${room.bots.length} bot`);
}

// Allinea i bot al max giocate degli utenti (può fare più giornate in cascata)
function syncBotMatchdays(room) {
    if (room.gameMode !== 'withBots' || !room.bots.length) return;
    const cap = Math.min(MAX_MATCHDAYS, maxUserPlayed(room));
    while (room.botMatchdaysSimulated < cap) {
        simulateBotsMatchday(room);
    }
}

// Trova il MAX giornate giocate fra gli utenti CONNESSI (esclude i disconnessi).
// Serve per allineare i disconnessi al play count dei giocatori effettivamente attivi.
function maxConnectedUserPlayed(room) {
    let max = 0;
    Object.keys(room.playerNamesById).forEach(id => {
        if (room.disconnectedSockets && room.disconnectedSockets[id]) return;
        const s = room.standings[id];
        if (s && typeof s === 'object' && (s.played || 0) > max) max = s.played;
    });
    return max;
}

// Allinea i giocatori DISCONNESSI alle giornate giocate dai connessi: simulazione "bot-like".
// Genera risultati random come per i bot, finché played < cap (cappato a MAX_MATCHDAYS).
function syncDisconnectedPlayersMatchdays(room) {
    if (!room.disconnectedSockets) return;
    const ids = Object.keys(room.disconnectedSockets);
    if (!ids.length) return;
    const cap = Math.min(MAX_MATCHDAYS, maxConnectedUserPlayed(room));
    if (cap <= 0) return;
    if (!room.matchHistoryById) room.matchHistoryById = {};
    ids.forEach(socketId => {
        // Se nel frattempo è uscito da disconnectedSockets (riconnesso), skip
        if (!room.disconnectedSockets[socketId]) return;
        ensureUserStats(room, socketId);
        const s = room.standings[socketId];
        let simulated = 0;
        if (!room.matchHistoryById[socketId]) room.matchHistoryById[socketId] = [];
        while ((s.played || 0) < cap && (s.played || 0) < MAX_MATCHDAYS) {
            const r = generateBotMatchResult();
            s.played++;
            s.gf += r.own;
            s.gs += r.opp;
            let points;
            if (r.own > r.opp) { points = 3; s.pt += 3; s.w++; }
            else if (r.own === r.opp) { points = 1; s.pt += 1; s.d++; }
            else { points = 0; s.l++; }
            // Storico (anche per i disconnessi, in modo che quando si riconnettono vedano il loro storico)
            room.matchHistoryById[socketId].push({
                own: r.own, opp: r.opp, points,
                verdict: points === 3 ? 'W' : (points === 1 ? 'D' : 'L'),
                oppName: '— (simulato)',
                matchday: s.played
            });
            simulated++;
        }
        if (simulated > 0) {
            const name = room.playerNamesById[socketId] || socketId.slice(0, 6);
            console.log(`[sim] disconnesso ${name} → simulate ${simulated} giornate (totale ${s.played}/${MAX_MATCHDAYS})`);
        }
    });
}

// Crea bot per riempire fino a 20 squadre totali
function ensureBotsCreated(room) {
    if (room.gameMode !== 'withBots') return;
    const userCount = Object.keys(room.playerNamesById).length;
    const target = Math.max(0, TARGET_TEAMS_TOTAL - userCount);
    if (room.bots.length >= target) return;
    const existingNames = room.bots.map(b => b.name);
    const newCount = target - room.bots.length;
    const newNames = pickRandomBotNames(newCount, existingNames);
    newNames.forEach((name, i) => {
        room.bots.push({
            id: 'bot_' + Date.now().toString(36) + '_' + i + '_' + Math.floor(Math.random() * 1000),
            name,
            stats: emptyStats()
        });
    });
}

// Ribilancia il numero di bot durante la lobby (prima dell'inizio partita).
// Se entrano utenti, rimuovo bot in eccesso (l'ultimo in classifica).
// Se utenti si disconnettono, aggiungo bot fino a 20 squadre totali.
// NON viene chiamata dopo gameStarted: in quel caso la sostituzione passa per replaceLastBotWithUser.
function rebalanceBotsInLobby(room) {
    if (room.gameMode !== 'withBots') return;
    if (room.gameStarted) return;
    const userCount = Object.keys(room.playerNamesById).length;
    const targetBotCount = Math.max(0, TARGET_TEAMS_TOTAL - userCount);
    // Rimuovi bot in eccesso (l'ultimo in classifica per primo, ma tanto in lobby tutte le stats sono 0)
    while (room.bots.length > targetBotCount) {
        const sorted = [...room.bots].sort((a, b) => {
            const sa = a.stats, sb = b.stats;
            if (sa.pt !== sb.pt) return sa.pt - sb.pt;
            const dra = sa.gf - sa.gs, drb = sb.gf - sb.gs;
            if (dra !== drb) return dra - drb;
            return sa.gf - sb.gf;
        });
        const idToRemove = sorted[0].id;
        room.bots = room.bots.filter(b => b.id !== idToRemove);
    }
    // Aggiungi bot mancanti
    if (room.bots.length < targetBotCount) {
        ensureBotsCreated(room);
    }
}

// Quando un nuovo utente entra a partita iniziata, sostituisce il bot ULTIMO in classifica
// e ne eredita stats e contatore giornate
function replaceLastBotWithUser(room, socketId) {
    if (room.gameMode !== 'withBots' || !room.bots.length) return false;
    // Ordina come la classifica: pt asc, dr asc, gf asc → primo = ultimo in classifica
    const sorted = [...room.bots].sort((a, b) => {
        const sa = a.stats, sb = b.stats;
        if (sa.pt !== sb.pt) return sa.pt - sb.pt;
        const dra = sa.gf - sa.gs, drb = sb.gf - sb.gs;
        if (dra !== drb) return dra - drb;
        if (sa.gf !== sb.gf) return sa.gf - sb.gf;
        return 0;
    });
    const lastBot = sorted[0];
    // Eredita stats: l'utente parte con played === bot.played → giornate restanti = 38-played
    room.standings[socketId] = { ...lastBot.stats };
    // Rimuovi il bot
    room.bots = room.bots.filter(b => b.id !== lastBot.id);
    console.log(`[bots] sostituito bot "${lastBot.name}" (${lastBot.stats.pt}pt, ${lastBot.stats.played}G) con utente ${socketId.slice(0,6)}`);
    return true;
}

// --- Stato per stanza ---
// rooms[roomId] = { playerNamesById, positions, turnOrder[], turnIndex, ... }
const rooms = {};

// === Grace period reconnessione ===
// Quando un socket si disconnette, manteniamo il suo stato (posizione/pedina/standings/squad)
// per RECONNECT_GRACE_MS millisecondi. Se un nuovo socket entra con lo stesso playerName
// nella stessa stanza entro questo tempo, il suo stato viene migrato dal vecchio socket.id
// al nuovo. Evita perdita dati per blip di rete o riavvii di tab.
// Finestra molto larga: vogliamo permettere ai giocatori (anche kickati dall'host)
// di rientrare in qualsiasi momento ragionevole conservando squadra + classifica + abilità.
// Dopo questo timeout, lo stato del giocatore disconnesso viene davvero ripulito.
const RECONNECT_GRACE_MS = 30 * 60 * 1000; // 30 minuti
const ROOM_EMPTY_GRACE_MS = 5 * 60 * 1000; // 5 min: la stanza vuota viene tenuta in vita
// disconnectedPlayers[roomId] = [ { oldSocketId, name, snapshot, timestamp } ]
const disconnectedPlayers = {};
// roomEmptySince[roomId] = timestamp di quando turnOrder è arrivato a 0
const roomEmptySince = {};

function getRoom(roomId) {
    if (!rooms[roomId]) {
        rooms[roomId] = {
            playerNamesById: {},
            positions: {},
            turnOrder: [],
            turnIndex: 0,
            matchPhaseIds: new Set(),         // socket id che sono in modalità PARTITA (assegnati avversario)
            matchActiveStartedIds: new Set(), // sottoinsieme: il loro turno match-attivo è effettivamente iniziato
            squads: {},                 // socketId → { 'slot-att-0': playerData, ... }
            matchOpponents: {},         // socketId → opponentSocketId (durante la sua match phase)
            matchScores: {},            // socketId → { own: N, opp: N } score della match phase corrente
            standings: {},              // socketId → { pt, w, d, l, gf, gs, played }
            pedineById: {},             // socketId → { type, color, emoji, customId } pedina personalizzata
            // === Modalità di gioco / impostazioni / bot ===
            hostSocketId: null,           // primo utente connesso = host (può cambiare impostazioni)
            gameMode: 'noBot',            // 'noBot' (default) | 'withBots'
            playerMode: 'virtual',        // 'virtual' (default) | 'real' — dimensione separata da gameMode
            gameStarted: false,           // true quando il primo utente entra in match phase: blocca le impostazioni
            bots: [],                     // [{ id, name, stats:{pt,w,d,l,gf,gs,played} }] popolato all'avvio in withBots
            botMatchdaysSimulated: 0,     // numero giornate già simulate dai bot (cap MAX_MATCHDAYS)
            // === Card filters: gestiti dall'host, applicati a tutta la stanza ===
            // Ogni array contiene gli ID delle carte DISATTIVATE (opt-out) per quella categoria.
            // Default (vuoto) = tutte le carte selezionate. Locked quando gameStarted=true.
            cardFilters: {
                ability: [],
                specialPlayer: [],
                goal: [],
                enemy: [],
                bonus: [],
                imprevisto: []
            },
            // === Stato personale per ogni giocatore (preservato anche su disconnect/reconnect) ===
            // socketId → { lapCount, abilities, totalDrawn, teamCount, mbappeCooldown, lastOpponentId }
            personalStates: {},
            // === Allenatori scelti dai giocatori ===
            // socketId → { coachId, coachSwitched, coachStartedAtLap, coachUsedPersonIds: [...] }
            coachesById: {},
            // === Libreria calciatori reali: array di ID deselezionati (opt-out, propagato dall'host) ===
            realPlayerFilter: [],
            // === Giocatori marcati come "disconnessi" (host kick o disconnect normale).
            // socketId → { kicked: bool, since: ts, name: '...' }
            // Mentre sono qui dentro, il loro turno viene SKIPPATO automaticamente nel turn-rotation.
            // Vengono ripuliti al reconnect.
            disconnectedSockets: {},
            // === VAR Sabotato: log dei match terminati di recente (vetoabili dai possessori della carta).
            // matchId numerico autoincrementante → { finisher, oppId, ownGoals, oppGoals, points,
            //   verdictKey ('W'|'D'|'L'), vetoed: false|socketId, ts: number }.
            // Solo gli ULTIMI N match restano (cleanup automatico) per evitare crescita illimitata.
            recentMatches: {},
            recentMatchCounter: 0,
            // === Storico match per ogni giocatore umano: socketId → [{own, opp, oppName, points, verdict:'W'|'D'|'L', matchday}]
            // Aggiornato a ogni match-result; modificato da VAR Sabotato sull'ultimo entry.
            matchHistoryById: {},
            // === Storico match simulati per ogni bot: botId → [{own, opp, points, verdict, matchday}]
            // I bot non hanno avversari nominati (i loro match sono simulati come somma di standings).
            botMatchHistoryById: {},
            // === 19.0: ECONOMIA (cassa, sponsor, mercato) per ogni giocatore umano ===
            // Struttura: socketId → { cash, lastEarning, sponsors: [3 slot], pendingSetup, winStreak, ... }
            economy: {}
        };
    }
    return rooms[roomId];
}

function snapshot(room) {
    const turnSocketId = room.turnOrder[room.turnIndex] || null;
    return {
        positions: { ...room.positions },
        playerNamesById: { ...room.playerNamesById },
        turnSocketId,
        matchPhaseIds: Array.from(room.matchPhaseIds),
        matchActiveStartedIds: Array.from(room.matchActiveStartedIds),
        squads: { ...room.squads },
        matchOpponents: { ...room.matchOpponents },
        matchScores: { ...room.matchScores },
        standings: { ...room.standings },
        pedineById: { ...room.pedineById },
        // Settings + bot state
        hostSocketId: room.hostSocketId,
        gameMode: room.gameMode,
        playerMode: room.playerMode || 'virtual',
        gameStarted: room.gameStarted,
        bots: room.bots.map(b => ({ id: b.id, name: b.name, stats: { ...b.stats } })),
        botMatchdaysSimulated: room.botMatchdaysSimulated,
        maxMatchdays: MAX_MATCHDAYS,
        cardFilters: {
            ability:       [...(room.cardFilters.ability || [])],
            specialPlayer: [...(room.cardFilters.specialPlayer || [])],
            goal:          [...(room.cardFilters.goal || [])],
            enemy:         [...(room.cardFilters.enemy || [])],
            bonus:         [...(room.cardFilters.bonus || [])],
            imprevisto:    [...(room.cardFilters.imprevisto || [])]
        },
        personalStates: { ...(room.personalStates || {}) },
        // ID dei giocatori al momento disconnessi (turno saltato finché tornano).
        disconnectedSocketIds: Object.keys(room.disconnectedSockets || {}),
        // Allenatori scelti per ogni giocatore (per visualizzazione + check sync)
        coachesById: JSON.parse(JSON.stringify(room.coachesById || {})),
        // Libreria calciatori reali: array di ID deselezionati
        realPlayerFilter: Array.isArray(room.realPlayerFilter) ? [...room.realPlayerFilter] : []
        ,
        // Storico match (umani + bot): consente al client di mostrare tutti i risultati nel modal info giocatore
        matchHistoryById: JSON.parse(JSON.stringify(room.matchHistoryById || {})),
        botMatchHistoryById: JSON.parse(JSON.stringify(room.botMatchHistoryById || {})),
        // === 19.0: ECONOMIA — cassa, sponsor, ultimo guadagno per ogni giocatore umano ===
        economy: JSON.parse(JSON.stringify(room.economy || {}))
    };
}

function sanitizeRoomId(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function sanitizeName(value) {
    return String(value || 'Manager').replace(/[^\wÀ-ÿ\s-]/g, '').trim().slice(0, 24) || 'Manager';
}

// Migra lo stato di un giocatore da un vecchio socket.id a uno nuovo.
// Usato quando un client si riconnette entro RECONNECT_GRACE_MS con lo stesso nome.
function migratePlayerState(room, oldSocketId, newSocketId) {
    if (!room || oldSocketId === newSocketId) return;
    // Player name: migra anche il nome dal vecchio al nuovo socketId (e rimuovi vecchia entry).
    // Safety net per evitare nomi duplicati in playerNamesById dopo la migrazione.
    if (room.playerNamesById[oldSocketId] !== undefined) {
        if (!room.playerNamesById[newSocketId]) {
            room.playerNamesById[newSocketId] = room.playerNamesById[oldSocketId];
        }
        delete room.playerNamesById[oldSocketId];
    }
    // Position
    if (room.positions[oldSocketId] !== undefined) {
        room.positions[newSocketId] = room.positions[oldSocketId];
        delete room.positions[oldSocketId];
    }
    // Turn order
    const ti = room.turnOrder.indexOf(oldSocketId);
    if (ti >= 0) {
        room.turnOrder[ti] = newSocketId;
    } else if (!room.turnOrder.includes(newSocketId)) {
        room.turnOrder.push(newSocketId);
    }
    // Match phase sets
    if (room.matchPhaseIds.has(oldSocketId)) {
        room.matchPhaseIds.delete(oldSocketId);
        room.matchPhaseIds.add(newSocketId);
    }
    if (room.matchActiveStartedIds.has(oldSocketId)) {
        room.matchActiveStartedIds.delete(oldSocketId);
        room.matchActiveStartedIds.add(newSocketId);
    }
    // Pedina, squad, opponents, scores, standings
    if (room.pedineById[oldSocketId]) { room.pedineById[newSocketId] = room.pedineById[oldSocketId]; delete room.pedineById[oldSocketId]; }
    if (room.squads[oldSocketId])     { room.squads[newSocketId]     = room.squads[oldSocketId];     delete room.squads[oldSocketId]; }
    if (room.matchScores[oldSocketId]){ room.matchScores[newSocketId]= room.matchScores[oldSocketId];delete room.matchScores[oldSocketId]; }
    if (room.standings[oldSocketId])  { room.standings[newSocketId]  = room.standings[oldSocketId];  delete room.standings[oldSocketId]; }
    // matchOpponents: chi era avversario di chi
    Object.keys(room.matchOpponents).forEach(id => {
        if (room.matchOpponents[id] === oldSocketId) room.matchOpponents[id] = newSocketId;
    });
    if (room.matchOpponents[oldSocketId]) {
        room.matchOpponents[newSocketId] = room.matchOpponents[oldSocketId];
        delete room.matchOpponents[oldSocketId];
    }
    // Host transfer se necessario
    if (room.hostSocketId === oldSocketId) room.hostSocketId = newSocketId;
    // Personal state (lap, abilità, totalDrawn, teamCount, mbappeCooldown, ecc.)
    if (room.personalStates && room.personalStates[oldSocketId]) {
        room.personalStates[newSocketId] = room.personalStates[oldSocketId];
        delete room.personalStates[oldSocketId];
    }
    // Disconnected sockets: rimuovi l'entry del vecchio socket (il giocatore è tornato)
    if (room.disconnectedSockets && room.disconnectedSockets[oldSocketId]) {
        delete room.disconnectedSockets[oldSocketId];
    }
    // Migrate coach scelto
    if (room.coachesById && room.coachesById[oldSocketId]) {
        room.coachesById[newSocketId] = room.coachesById[oldSocketId];
        delete room.coachesById[oldSocketId];
    }
    // Migrate storico match
    if (room.matchHistoryById && room.matchHistoryById[oldSocketId]) {
        room.matchHistoryById[newSocketId] = room.matchHistoryById[oldSocketId];
        delete room.matchHistoryById[oldSocketId];
    }
    // 19.0: Migrate economia (cassa, sponsor, breakdown)
    if (room.economy && room.economy[oldSocketId]) {
        room.economy[newSocketId] = room.economy[oldSocketId];
        delete room.economy[oldSocketId];
    }
}

io.on('connection', (socket) => {
    let joinedRoomId = null;

    socket.on('join-room', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId);
        if (!roomId) return;
        joinedRoomId = roomId;
        const safeName = sanitizeName(payload.playerName);
        socket.join(roomId);

        const room = getRoom(roomId);
        // Cancella il timer "stanza vuota" se la stanza viene rioccupata
        if (roomEmptySince[roomId]) delete roomEmptySince[roomId];

        // === RECONNECT DETECTION (a 3 livelli, dal più stretto al più permissivo) ===
        // Livello 1: cerca in disconnectedPlayers[] (grace period 30 min, normale flow)
        const recentArr = disconnectedPlayers[roomId] || [];
        let reconnectEntry = recentArr.find(d =>
            d.name === safeName && (Date.now() - d.timestamp) < RECONNECT_GRACE_MS
        );
        let reconnected = false;
        let reconnectSource = '';
        if (reconnectEntry) {
            reconnectSource = 'grace';
        } else {
            // Livello 2: nessun entry nel grace, ma cerco se esiste un socket DISCONNESSO con stesso nome
            // (anti-doppione: se per qualche motivo l'entry grace è stata pulita ma il vecchio socket
            //  è ancora in room.disconnectedSockets, va comunque riconosciuto come reconnect).
            const oldSocketId = Object.keys(room.disconnectedSockets || {}).find(sid => {
                const info = room.disconnectedSockets[sid];
                return info && info.name === safeName;
            });
            if (oldSocketId) {
                reconnectEntry = { oldSocketId, name: safeName, timestamp: Date.now() };
                reconnectSource = 'disconnectedSockets';
            } else {
                // Livello 3: cerca in playerNamesById un socket CON STESSO NOME (anche se non marcato come disconnesso).
                // Questo elimina il bug del "doppione": se entra qualcuno con un nome già esistente in stanza,
                // assumo sia un reconnect (lo stesso utente da nuovo socket) e migro lo stato — invece di
                // creare un secondo entry e sostituire un bot.
                const sameNameSocketId = Object.keys(room.playerNamesById).find(sid =>
                    room.playerNamesById[sid] === safeName && sid !== socket.id
                );
                if (sameNameSocketId) {
                    reconnectEntry = { oldSocketId: sameNameSocketId, name: safeName, timestamp: Date.now() };
                    reconnectSource = 'sameName';
                }
            }
        }
        if (reconnectEntry) {
            const oldId = reconnectEntry.oldSocketId;
            // Rimuovi il vecchio nome (era ancora in playerNamesById se non scaduto il grace)
            delete room.playerNamesById[oldId];
            migratePlayerState(room, oldId, socket.id);
            disconnectedPlayers[roomId] = recentArr.filter(d => d.oldSocketId !== oldId);
            // Rimuovo dal disconnectedSockets se era ancora lì (migratePlayerState lo fa già, ma safety)
            if (room.disconnectedSockets) delete room.disconnectedSockets[oldId];
            reconnected = true;
            console.log(`[${roomId}] RECONNECT ${safeName} via ${reconnectSource} (${oldId.slice(0,6)} → ${socket.id.slice(0,6)})`);
        }

        const isFirst = Object.keys(room.playerNamesById).length === 0;
        room.playerNamesById[socket.id] = safeName;
        if (!(socket.id in room.positions)) room.positions[socket.id] = 0;
        if (!room.turnOrder.includes(socket.id)) room.turnOrder.push(socket.id);

        // Host: solo se davvero primo (e nessuno ha già il ruolo) e NON è un reconnect
        if (!reconnected && (!room.hostSocketId || isFirst)) {
            room.hostSocketId = socket.id;
        }

        // Bot logic: solo se NON è un reconnect (per non rifare la sostituzione)
        if (!reconnected) {
            if (room.gameStarted && room.gameMode === 'withBots' && room.bots.length > 0) {
                replaceLastBotWithUser(room, socket.id);
            } else if (!room.gameStarted && room.gameMode === 'withBots') {
                rebalanceBotsInLobby(room);
            }
        }

        const snap = snapshot(room);
        socket.emit('room-joined', snap);
        socket.to(roomId).emit('room-presence', snap);

        console.log(`[${roomId}] + ${safeName} (${socket.id.slice(0, 6)})${isFirst && !reconnected ? ' [HOST]' : ''}${reconnected ? ' [RECONNECT]' : ''} — totale: ${room.turnOrder.length}`);
    });

    // Cambio modalità di gioco (solo host, solo prima dell'inizio partita)
    socket.on('update-game-mode', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (socket.id !== room.hostSocketId) {
            console.log(`[${roomId}] update-game-mode rifiutato: non sei l'host`);
            return;
        }
        if (room.gameStarted) {
            console.log(`[${roomId}] update-game-mode rifiutato: partita già iniziata`);
            return;
        }
        const mode = (payload.mode === 'withBots') ? 'withBots' : 'noBot';
        room.gameMode = mode;
        if (mode === 'withBots') {
            // Crea subito i bot per riempire fino a 20 squadre, così sono visibili
            // nella classifica già dalla lobby (con stats a 0)
            ensureBotsCreated(room);
            console.log(`[${roomId}] gameMode → withBots: creati ${room.bots.length} bot (utenti: ${Object.keys(room.playerNamesById).length})`);
        } else {
            // Passaggio a noBot: pulisco eventuali bot precedenti
            room.bots = [];
            room.botMatchdaysSimulated = 0;
            console.log(`[${roomId}] gameMode → noBot: bot rimossi`);
        }
        io.to(roomId).emit('state-updated', snapshot(room));
    });

    // Cambio modalità calciatori (virtual / real) — solo host, solo prima dell'inizio partita
    socket.on('update-player-mode', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (socket.id !== room.hostSocketId) {
            console.log(`[${roomId}] update-player-mode rifiutato: non sei l'host`);
            return;
        }
        if (room.gameStarted) {
            console.log(`[${roomId}] update-player-mode rifiutato: partita già iniziata`);
            return;
        }
        const mode = (payload.mode === 'real') ? 'real' : 'virtual';
        room.playerMode = mode;
        console.log(`[${roomId}] playerMode → ${mode}`);
        io.to(roomId).emit('state-updated', snapshot(room));
    });

    // Cambio filtri carte (solo host, solo prima dell'inizio partita)
    // Payload: { category, deselectedIds: [...] }  oppure  { filters: {...} } (full state)
    socket.on('update-card-filters', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (socket.id !== room.hostSocketId) {
            console.log(`[${roomId}] update-card-filters rifiutato: non sei l'host`);
            return;
        }
        if (room.gameStarted) {
            console.log(`[${roomId}] update-card-filters rifiutato: partita già iniziata`);
            return;
        }
        const validCats = ['ability', 'specialPlayer', 'goal', 'enemy', 'bonus', 'imprevisto'];
        // Sanitize: only string/number IDs, max 500 per category
        const sanitizeIds = (arr) => {
            if (!Array.isArray(arr)) return [];
            return arr.slice(0, 500).map(x => {
                if (typeof x === 'string') return x.slice(0, 200);
                if (typeof x === 'number') return x;
                return null;
            }).filter(x => x !== null);
        };
        if (payload.filters && typeof payload.filters === 'object') {
            for (const cat of validCats) {
                room.cardFilters[cat] = sanitizeIds(payload.filters[cat]);
            }
        } else if (validCats.includes(payload.category)) {
            room.cardFilters[payload.category] = sanitizeIds(payload.deselectedIds);
        } else {
            return;
        }
        io.to(roomId).emit('state-updated', snapshot(room));
        console.log(`[${roomId}] cardFilters aggiornati (host: ${socket.id.slice(0,6)})`);
    });

    socket.on('update-position', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (Number.isInteger(payload.position)) {
            room.positions[socket.id] = payload.position;
        }
        io.to(roomId).emit('state-updated', {
            positions: { ...room.positions },
            playerNamesById: { ...room.playerNamesById },
            matchPhaseIds: Array.from(room.matchPhaseIds)
        });
    });

    socket.on('match-phase-update', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (payload.inMatch === true) {
            // PRIMA volta che QUALCUNO entra in match phase → blocca le impostazioni e crea bot se serve
            if (!room.gameStarted) {
                room.gameStarted = true;
                if (room.gameMode === 'withBots') {
                    ensureBotsCreated(room);
                    console.log(`[${roomId}] gameStarted (withBots): creati ${room.bots.length} bot per ${Object.keys(room.playerNamesById).length} utenti`);
                } else {
                    console.log(`[${roomId}] gameStarted (noBot)`);
                }
            }
            room.matchPhaseIds.add(socket.id);
            // Assegna avversario casuale (escluso me stesso, l'ultimo affrontato se possibile,
            // E i giocatori attualmente DISCONNESSI — non sfidabili).
            const isDisconnected = (id) => !!(room.disconnectedSockets && room.disconnectedSockets[id]);
            const allCandidates = Object.keys(room.playerNamesById)
                .filter(id => id !== socket.id && !isDisconnected(id));
            const lastOpp = room.personalStates[socket.id] && room.personalStates[socket.id].lastOpponentId;
            // Preferisco candidati diversi dall'ultimo avversario affrontato; se è l'unico, lo accetto
            const preferred = (lastOpp && allCandidates.length > 1)
                ? allCandidates.filter(id => id !== lastOpp)
                : allCandidates;
            const pool = preferred.length ? preferred : allCandidates;
            if (pool.length > 0) {
                const newOpp = pool[Math.floor(Math.random() * pool.length)];
                room.matchOpponents[socket.id] = newOpp;
                room.matchScores[socket.id] = { own: 0, opp: 0 };
                // Memorizza per il prossimo match (così evitiamo di ripeterlo)
                if (!room.personalStates[socket.id]) room.personalStates[socket.id] = {};
                room.personalStates[socket.id].lastOpponentId = newOpp;
            }
        } else {
            room.matchPhaseIds.delete(socket.id);
            room.matchActiveStartedIds.delete(socket.id);
            delete room.matchOpponents[socket.id];
            delete room.matchScores[socket.id];
        }
        io.to(roomId).emit('state-updated', snapshot(room));
        console.log(`[${roomId}] match-phase ${payload.inMatch ? '+' : '-'} ${socket.id.slice(0, 6)}${payload.inMatch && room.matchOpponents[socket.id] ? ' vs ' + room.matchOpponents[socket.id].slice(0, 6) : ''}`);
    });

    // Il client segnala che il suo turno match-attivo è effettivamente iniziato (al ritorno del turno)
    socket.on('match-active-start', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (!room.matchPhaseIds.has(socket.id)) return; // deve essere già in match phase
        if (room.matchActiveStartedIds.has(socket.id)) return; // già iniziato
        room.matchActiveStartedIds.add(socket.id);
        io.to(roomId).emit('state-updated', snapshot(room));
        console.log(`[${roomId}] match-active START ${socket.id.slice(0, 6)}`);
    });

    // Personalizzazione pedina: il client comunica la sua selezione, server la salva e broadcast
    socket.on('pedina-update', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const sel = payload.selection;
        if (!sel || typeof sel !== 'object') return;
        // Type può essere 'default' | 'custom' (URL preset) | 'customImage' (data URL caricato)
        let type = 'default';
        if (sel.type === 'custom') type = 'custom';
        else if (sel.type === 'customImage') type = 'customImage';
        const data = {
            type,
            color: typeof sel.color === 'string' ? sel.color.slice(0, 12) : '#3498db',
            emoji: typeof sel.emoji === 'string' ? sel.emoji.slice(0, 8) : '⚽',
            customId: typeof sel.customId === 'string' ? sel.customId.slice(0, 32) : null
        };
        // Custom image: data URL (max ~600KB per sicurezza, JPEG di 300x300 q.85 sta sotto i 100KB)
        if (type === 'customImage' && typeof sel.customImageData === 'string') {
            const url = sel.customImageData;
            const MAX_LEN = 600 * 1024; // 600 KB hard limit lato server
            if (url.length <= MAX_LEN && /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(url)) {
                data.customImageData = url;
            } else {
                // Sanity check fallita → fallback a default
                data.type = 'default';
            }
        }
        room.pedineById[socket.id] = data;
        io.to(roomId).emit('state-updated', snapshot(room));
    });

    // Stato personale del giocatore (preservato su reconnect)
    // === REAL PLAYER FILTER: l'host invia la lista degli ID DESELEZIONATI dalla libreria reali ===
    socket.on('update-real-player-filter', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (socket.id !== room.hostSocketId) return; // solo host
        if (room.gameStarted) return; // bloccato dopo l'inizio
        const ids = Array.isArray(payload.deselectedIds)
            ? payload.deselectedIds.slice(0, 5000).map(s => String(s).slice(0, 40)).filter(Boolean)
            : [];
        room.realPlayerFilter = ids;
        io.to(roomId).emit('state-updated', snapshot(room));
        console.log(`[${roomId}] update-real-player-filter: ${ids.length} ID deselezionati`);
    });

    // === COACH UPDATE: il client invia la propria scelta di allenatore. ===
    // Server salva in room.coachesById e broadcast state-updated a tutti.
    socket.on('coach-update', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (!room.coachesById) room.coachesById = {};
        const coachId = typeof payload.coachId === 'string' ? payload.coachId.slice(0, 60) : null;
        const coachSwitched = !!payload.coachSwitched;
        const coachStartedAtLap = parseInt(payload.coachStartedAtLap) || 0;
        const usedPersonIds = Array.isArray(payload.coachUsedPersonIds)
            ? payload.coachUsedPersonIds.slice(0, 30).map(s => String(s).slice(0, 40)).filter(Boolean)
            : [];
        // Stato specifico Marie-Louise Eta (contatore dadi + dado extra in coda)
        const etaDiceRollCount = Number.isFinite(payload.etaDiceRollCount) ? Math.max(0, parseInt(payload.etaDiceRollCount)) : 0;
        const etaNextRollHasExtraDie = !!payload.etaNextRollHasExtraDie;
        room.coachesById[socket.id] = {
            coachId,
            coachSwitched,
            coachStartedAtLap,
            coachUsedPersonIds: usedPersonIds,
            etaDiceRollCount,
            etaNextRollHasExtraDie
        };
        io.to(roomId).emit('state-updated', snapshot(room));
        const name = room.playerNamesById[socket.id] || socket.id.slice(0,6);
        console.log(`[${roomId}] coach-update ${name} → ${coachId || 'null'} (switched=${coachSwitched}, lap=${coachStartedAtLap})`);
    });

    socket.on('sync-personal-state', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        // Sanitize: solo i campi attesi
        const state = {
            lapCount: parseInt(payload.lapCount) || 0,
            totalDrawn: parseInt(payload.totalDrawn) || 0,
            teamCount: (payload.teamCount && typeof payload.teamCount === 'object') ? payload.teamCount : {},
            mbappeCooldown: parseInt(payload.mbappeCooldown) || 0,
            lastOpponentId: typeof payload.lastOpponentId === 'string' ? payload.lastOpponentId.slice(0, 64) : null,
            // Abilità in mano: array di {instanceId, template} — passiamo come è (size limit 30 per sicurezza)
            abilities: Array.isArray(payload.abilities) ? payload.abilities.slice(0, 30) : [],
            // Log riflessi elettrici di Gigante Elettrico (per reconnect)
            electricReflectionLog: (payload.electricReflectionLog && typeof payload.electricReflectionLog === 'object')
                ? payload.electricReflectionLog : {},
            // === Flag stato locale (per save/load esatto) ===
            currentIdx: Number.isFinite(parseInt(payload.currentIdx)) ? parseInt(payload.currentIdx) : 0,
            lapPending: !!payload.lapPending,
            needToDrawGoalCard: !!payload.needToDrawGoalCard,
            needToDrawEnemyCard: !!payload.needToDrawEnemyCard,
            needToDrawBonusCard: !!payload.needToDrawBonusCard,
            needToDrawImprevistoCard: !!payload.needToDrawImprevistoCard,
            needToDrawAbilityCard: !!payload.needToDrawAbilityCard,
            needToDrawSpecialPlayer: !!payload.needToDrawSpecialPlayer,
            cancelNextEnemyShowdown: !!payload.cancelNextEnemyShowdown,
            currentShowdownCellIdx: (payload.currentShowdownCellIdx == null) ? null : (Number.isFinite(parseInt(payload.currentShowdownCellIdx)) ? parseInt(payload.currentShowdownCellIdx) : null),
            activeTrainingPoints: Number.isFinite(parseInt(payload.activeTrainingPoints)) ? parseInt(payload.activeTrainingPoints) : 0,
            allowedStat: typeof payload.allowedStat === 'string' ? payload.allowedStat.slice(0, 20) : null,
            justEnteredMatchThisTurn: !!payload.justEnteredMatchThisTurn,
            hadOffTurnSinceMatchEntry: !!payload.hadOffTurnSinceMatchEntry
        };
        room.personalStates[socket.id] = state;
        // Non broadcast: solo il server tiene la copia per il reconnect
    });

    socket.on('squad-update', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (payload.squad && typeof payload.squad === 'object') {
            room.squads[socket.id] = payload.squad;
            io.to(roomId).emit('state-updated', snapshot(room));
        }
    });

    socket.on('goal-result', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (!room.matchScores[socket.id]) return;
        if (payload.isGoal === true) {
            room.matchScores[socket.id].own++;
            console.log(`[${roomId}] GOL di ${socket.id.slice(0, 6)} (${room.matchScores[socket.id].own} totali)`);
        }
        io.to(roomId).emit('state-updated', snapshot(room));
    });

    // OCC AVVERSARIA risolta: l'avversario ha segnato → io concedo gol
    socket.on('enemy-result', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (!room.matchScores[socket.id]) return;
        if (payload.isGoal === true) {
            room.matchScores[socket.id].opp++;
            console.log(`[${roomId}] GOL SUBITO da ${socket.id.slice(0, 6)} (${room.matchScores[socket.id].opp} totali)`);
        }
        io.to(roomId).emit('state-updated', snapshot(room));
    });

    // Fine match: assegna punti + statistiche estese (solo a chi ha giocato)
    socket.on('match-result', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const points = parseInt(payload.points) || 0;
        const ownGoals = parseInt(payload.ownGoals) || 0;
        const oppGoals = parseInt(payload.oppGoals) || 0;
        if (!Number.isFinite(points) || points < 0) return;
        // Inizializzo struct se non esiste (o se è ancora il vecchio formato number)
        if (!room.standings[socket.id] || typeof room.standings[socket.id] !== 'object') {
            room.standings[socket.id] = { pt: 0, w: 0, d: 0, l: 0, gf: 0, gs: 0, played: 0 };
        }
        const s = room.standings[socket.id];
        s.pt += points;
        s.gf += ownGoals;
        s.gs += oppGoals;
        s.played++;
        if (points === 3) s.w++;
        else if (points === 1) s.d++;
        else s.l++;
        const verdict = points === 3 ? 'VITTORIA' : (points === 1 ? 'PAREGGIO' : 'SCONFITTA');
        console.log(`[${roomId}] match ${socket.id.slice(0, 6)}: ${ownGoals}-${oppGoals} ${verdict} (+${points} pt) | totale: ${s.pt}pt, ${s.played}G ${s.w}V ${s.d}N ${s.l}S, GF:${s.gf} GS:${s.gs}`);

        // === STORICO MATCH: aggiungo entry alla lista del giocatore ===
        if (!room.matchHistoryById) room.matchHistoryById = {};
        if (!room.matchHistoryById[socket.id]) room.matchHistoryById[socket.id] = [];
        // Recupero nome avversario reale (può essere un altro giocatore umano o un bot)
        let oppNameHist = 'Avversario';
        try {
            const oppSocketId = room.matchOpponents && room.matchOpponents[socket.id];
            if (oppSocketId) {
                if (room.playerNamesById[oppSocketId]) {
                    oppNameHist = room.playerNamesById[oppSocketId];
                } else {
                    const bot = (room.bots || []).find(b => b && b.id === oppSocketId);
                    if (bot) oppNameHist = bot.name;
                }
            }
        } catch (e) {}
        const matchHistEntry = {
            own: ownGoals, opp: oppGoals, points,
            verdict: points === 3 ? 'W' : (points === 1 ? 'D' : 'L'),
            oppName: oppNameHist,
            matchday: s.played
        };
        room.matchHistoryById[socket.id].push(matchHistEntry);

        // === 19.0 — PAGAMENTO SPONSOR per la giornata appena conclusa ===
        // currentLap = s.played (giornate giocate, 1-based dopo l'incremento del match-result)
        try {
            const payRes = applySponsorPaymentsForLap(room, socket.id, matchHistEntry, s.played);
            if (payRes) {
                console.log(`[${roomId}] sponsor pay ${socket.id.slice(0,6)} G${s.played}: +${payRes.total} → cassa ${payRes.cashAfter}`);
                // Notifica privata al giocatore con il breakdown (per UI "ultimo guadagno")
                io.to(socket.id).emit('sponsor-payment', {
                    lap: s.played,
                    total: payRes.total,
                    breakdown: payRes.breakdown,
                    cashAfter: payRes.cashAfter
                });
            }
        } catch (e) { console.warn('[sponsor pay fail]', e && e.message); }
        // === Bot: se la modalità è "withBots", sincronizza la simulazione delle giornate
        // (i bot simulano UNA giornata ogni volta che il MAX di played aumenta — cap a 38)
        if (room.gameMode === 'withBots' && room.bots.length > 0) {
            syncBotMatchdays(room);
        }
        // === Disconnessi: simulano le loro giornate come i bot finché restano disconnessi.
        // Questo li mantiene allineati alla classifica e impedisce che restino indietro.
        syncDisconnectedPlayersMatchdays(room);
        io.to(roomId).emit('state-updated', snapshot(room));

        // === VAR Sabotato: registro il match come "vetoabile" SOLO se è una partita umana
        // (i bot non emettono match-result, quindi sono già esclusi automaticamente).
        // Solo gli AVVERSARI con la carta A26 in mano potranno annullare un gol entro 12s.
        if (!room.recentMatches) { room.recentMatches = {}; room.recentMatchCounter = 0; }
        room.recentMatchCounter++;
        const matchId = room.recentMatchCounter;
        const verdictKey = points === 3 ? 'W' : (points === 1 ? 'D' : 'L');
        room.recentMatches[matchId] = {
            finisherSocketId: socket.id,
            finisherName: room.playerNamesById[socket.id] || 'Giocatore',
            ownGoals, oppGoals, points,
            verdictKey,
            vetoed: false,
            ts: Date.now()
        };
        // Cleanup match più vecchi di 60s (manteniamo solo i recenti per evitare crescita)
        const cutoff = Date.now() - 60000;
        Object.keys(room.recentMatches).forEach(k => {
            if (room.recentMatches[k].ts < cutoff) delete room.recentMatches[k];
        });
        // Broadcast SOLO se ownGoals >= 1 (altrimenti VAR non serve, niente da togliere)
        // Inviato a TUTTI tranne il finisher (gli altri valuteranno se hanno la carta A26)
        if (ownGoals >= 1) {
            socket.broadcast.to(roomId).emit('match-finished-vetoable', {
                matchId,
                finisherSocketId: socket.id,
                finisherName: room.playerNamesById[socket.id] || 'Giocatore',
                ownGoals,
                oppGoals,
                points,
                ts: Date.now()
            });
        }
    });

    // === VAR Sabotato a fine match: primo arrivato vince ===
    socket.on('var-sabotato-use', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const matchId = parseInt(payload.matchId);
        if (!Number.isFinite(matchId) || !room.recentMatches || !room.recentMatches[matchId]) {
            socket.emit('var-sabotato-too-late', { matchId, reason: 'expired' });
            return;
        }
        const entry = room.recentMatches[matchId];
        if (entry.vetoed) {
            socket.emit('var-sabotato-too-late', { matchId, reason: 'already_used', byName: entry.vetoedByName || 'qualcun altro' });
            return;
        }
        if (entry.finisherSocketId === socket.id) {
            socket.emit('var-sabotato-too-late', { matchId, reason: 'self' });
            return;
        }
        if (entry.ownGoals < 1) {
            socket.emit('var-sabotato-too-late', { matchId, reason: 'no_goals' });
            return;
        }
        // === ATOMIC: marca vetoed con socket.id ===
        entry.vetoed = socket.id;
        entry.vetoedByName = room.playerNamesById[socket.id] || 'Giocatore';

        // === Ricalcolo standings del finisher ===
        const newOwnGoals = entry.ownGoals - 1;
        // Nuovo verdict in base al nuovo score
        let newPoints, newVerdictKey;
        if (newOwnGoals > entry.oppGoals) { newPoints = 3; newVerdictKey = 'W'; }
        else if (newOwnGoals === entry.oppGoals) { newPoints = 1; newVerdictKey = 'D'; }
        else { newPoints = 0; newVerdictKey = 'L'; }
        const deltaPoints = newPoints - entry.points;
        const fs = room.standings[entry.finisherSocketId];
        if (fs && typeof fs === 'object') {
            fs.pt = Math.max(0, fs.pt + deltaPoints);
            fs.gf = Math.max(0, fs.gf - 1);
            // Aggiusto W/D/L: rimuovo il vecchio verdict e aggiungo il nuovo
            if (entry.verdictKey === 'W') fs.w = Math.max(0, fs.w - 1);
            else if (entry.verdictKey === 'D') fs.d = Math.max(0, fs.d - 1);
            else fs.l = Math.max(0, fs.l - 1);
            if (newVerdictKey === 'W') fs.w++;
            else if (newVerdictKey === 'D') fs.d++;
            else fs.l++;
        }
        // Aggiusto anche l'ultimo entry dello storico match del finisher
        try {
            const hist = room.matchHistoryById && room.matchHistoryById[entry.finisherSocketId];
            if (Array.isArray(hist) && hist.length > 0) {
                const last = hist[hist.length - 1];
                last.own = newOwnGoals;
                last.points = newPoints;
                last.verdict = newVerdictKey;
                last.varSabotato = true; // flag: questo match è stato modificato da VAR
            }
        } catch (e) {}
        console.log(`[${roomId}] VAR Sabotato by ${entry.vetoedByName} → ${entry.finisherName}: ${entry.ownGoals}-${entry.oppGoals} (${entry.points}pt) → ${newOwnGoals}-${entry.oppGoals} (${newPoints}pt) | Δ=${deltaPoints}pt`);

        // Notifica al claimante: VAR applicato con successo
        socket.emit('var-sabotato-applied', {
            matchId,
            finisherName: entry.finisherName,
            oldScore: `${entry.ownGoals}-${entry.oppGoals}`,
            newScore: `${newOwnGoals}-${entry.oppGoals}`,
            deltaPoints
        });
        // Notifica al finisher: hai ricevuto VAR
        io.to(entry.finisherSocketId).emit('var-sabotato-received', {
            matchId,
            fromName: entry.vetoedByName,
            oldScore: `${entry.ownGoals}-${entry.oppGoals}`,
            newScore: `${newOwnGoals}-${entry.oppGoals}`,
            deltaPoints
        });
        // Broadcast a TUTTI il nuovo state (classifica aggiornata) + chiudi modal agli altri
        io.to(roomId).emit('var-sabotato-resolved', {
            matchId,
            byName: entry.vetoedByName,
            finisherName: entry.finisherName
        });
        io.to(roomId).emit('state-updated', snapshot(room));
    });

    // ====================================================================
    // 19.0 — SPONSOR / ECONOMIA: setup, swap, pagamenti
    // ====================================================================

    // Il client richiede di iniziare il setup sponsor (es. dopo aver pescato gli 11 calciatori).
    // Il server pesca 3 opzioni per lo slot 0 (o il prossimo non occupato) e le invia.
    socket.on('sponsor-setup-start', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const e = ensureEconomy(room, socket.id);
        if (e.sponsors.every(s => s)) {
            socket.emit('sponsor-setup-state', { done: true, sponsors: e.sponsors, pending: null });
            return;
        }
        startSponsorSetup(room, socket.id);
        socket.emit('sponsor-setup-state', {
            done: false,
            sponsors: e.sponsors,
            pending: e.pendingSetup ? {
                slotIdx: e.pendingSetup.slotIdx,
                options: e.pendingSetup.options.map(id => getSponsorById(id)).filter(Boolean)
            } : null
        });
    });

    // Il client comunica la sua scelta tra le 3 opzioni pendenti.
    socket.on('sponsor-setup-pick', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const e = ensureEconomy(room, socket.id);
        const chosenId = parseInt(payload.sponsorId);
        if (!e.pendingSetup) return;
        if (!Number.isFinite(chosenId) || !e.pendingSetup.options.includes(chosenId)) return;
        const slotIdx = e.pendingSetup.slotIdx;
        const currentLap = (room.standings[socket.id] && room.standings[socket.id].played) || 0;
        e.sponsors[slotIdx] = {
            sponsorId: chosenId,
            signedAtLap: currentLap
        };
        e.pendingSetup = null;
        // Se ci sono altri slot da riempire, prepara la prossima triade
        if (e.sponsors.some(s => !s)) {
            startSponsorSetup(room, socket.id);
        }
        socket.emit('sponsor-setup-state', {
            done: e.sponsors.every(s => s),
            sponsors: e.sponsors,
            pending: e.pendingSetup ? {
                slotIdx: e.pendingSetup.slotIdx,
                options: e.pendingSetup.options.map(id => getSponsorById(id)).filter(Boolean)
            } : null
        });
        io.to(roomId).emit('state-updated', snapshot(room));
    });

    // Cambio sponsor: il client elenca quali slot vuole rigenerare (dopo 10 giornate dalla firma).
    // Server pesca 3 nuove opzioni per ogni slot richiesto. Slot in coda; il client conferma uno alla volta.
    socket.on('sponsor-swap-start', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const e = ensureEconomy(room, socket.id);
        const slotIdx = parseInt(payload.slotIdx);
        if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx > 2) return;
        const slot = e.sponsors[slotIdx];
        if (!slot) return;
        const currentLap = (room.standings[socket.id] && room.standings[socket.id].played) || 0;
        if ((currentLap - (slot.signedAtLap || 0)) < SPONSOR_SWAP_MIN_LAP_GAP) {
            socket.emit('sponsor-swap-denied', {
                slotIdx,
                reason: 'cooldown',
                neededLap: (slot.signedAtLap || 0) + SPONSOR_SWAP_MIN_LAP_GAP
            });
            return;
        }
        // Pesca 3 nuove opzioni (anche pari all'attuale: l'utente è OBBLIGATO a sceglierne una qualsiasi)
        e.pendingSetup = {
            slotIdx,
            options: drawSponsorOptions([]),
            isSwap: true
        };
        socket.emit('sponsor-setup-state', {
            done: false,
            sponsors: e.sponsors,
            pending: {
                slotIdx,
                options: e.pendingSetup.options.map(id => getSponsorById(id)).filter(Boolean),
                isSwap: true
            }
        });
    });

    // Acquisto pacchetto: deduce prezzo dalla cassa, pesca 3 carte random dal mazzo.
    // Le 3 carte sono SOLO IDs (template); il client le mostra. Poi il client comunica se tiene 1 carta
    // (con `pack-keep` + slot da sostituire) o le scarta tutte (con `pack-discard-all`).
    // NB: la generazione delle 3 carte avviene CLIENT-SIDE perché createPlayerData usa template ricchi.
    // Il server qui valida cassa + autorizza. Restituisce un "pack-token" che il client userà per "tenere".
    socket.on('pack-buy', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const e = ensureEconomy(room, socket.id);
        const deckType = parseInt(payload.deckType);
        const price = PACK_PRICES[deckType];
        if (!price) {
            socket.emit('pack-denied', { reason: 'invalid_deck', deckType });
            return;
        }
        if (e.cash < price) {
            socket.emit('pack-denied', { reason: 'no_funds', need: price, have: e.cash });
            return;
        }
        e.cash -= price;
        // Marca acquisto per sponsor #30 (Spendaccione)
        const currentLap = (room.standings[socket.id] && room.standings[socket.id].played) || 0;
        e.lastPackBuyLap = currentLap;
        // Token monouso per autorizzare il "keep" lato server (anti-replay)
        if (!room.packTokens) room.packTokens = {};
        const token = 'pk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
        room.packTokens[token] = { socketId: socket.id, deckType, ts: Date.now() };
        socket.emit('pack-granted', { deckType, price, cashAfter: e.cash, token });
        io.to(roomId).emit('state-updated', snapshot(room));
    });

    // Il client tiene 1 carta del pacchetto (le altre 2 vengono scartate senza punti allenamento).
    // Passa la carta scelta + lo slot da sostituire. Server consuma il token.
    // (Il vero swap dei dati squadra avviene client-side; qui aggiorniamo solo `room.squads`.)
    socket.on('pack-keep', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const token = String(payload.token || '');
        if (!room.packTokens || !room.packTokens[token]) return;
        if (room.packTokens[token].socketId !== socket.id) return;
        delete room.packTokens[token];
        // Il client emette un normale 'squad-update' subito dopo: tutto il rest stata si sincronizza così.
        // Nessuna altra azione qui — semplice ack.
        socket.emit('pack-keep-ack', {});
    });

    socket.on('pack-discard-all', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const token = String(payload.token || '');
        if (room.packTokens && room.packTokens[token] && room.packTokens[token].socketId === socket.id) {
            delete room.packTokens[token];
        }
        socket.emit('pack-discard-ack', {});
    });

    // Spectator broadcast: relay senza side-effects, solo per sincronizzare l'UI
    socket.on('goal-draw', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        socket.broadcast.to(roomId).emit('goal-draw-broadcast', {
            drawerSocketId: socket.id,
            card: payload.card
        });
    });

    socket.on('goal-confront', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        socket.broadcast.to(roomId).emit('goal-confront-broadcast', {
            drawerSocketId: socket.id
        });
    });

    socket.on('goal-close', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        socket.broadcast.to(roomId).emit('goal-close-broadcast', {
            drawerSocketId: socket.id
        });
    });

    // Broadcast spectator OCC AVVERSARIA: stessa pattern dei goal events
    socket.on('enemy-draw', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        socket.broadcast.to(roomId).emit('enemy-draw-broadcast', {
            drawerSocketId: socket.id,
            card: payload.card
        });
    });

    socket.on('enemy-confront', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        socket.broadcast.to(roomId).emit('enemy-confront-broadcast', {
            drawerSocketId: socket.id
        });
    });

    socket.on('enemy-close', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        socket.broadcast.to(roomId).emit('enemy-close-broadcast', {
            drawerSocketId: socket.id
        });
    });

    // Abilità: applica modificatore esterno (infortunio, espulsione, nerf stat) alla squadra di un altro giocatore.
    // Il server fa solo da relay: passa il payload al client target che lo applicherà alla sua squadra locale.
    socket.on('apply-external-modifier', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const targetSocketId = payload.targetSocketId;
        if (!targetSocketId) return;
        // Inoltra solo al target (privato per il target che vede l'effetto sulla sua squadra)
        io.to(targetSocketId).emit('external-modifier-received', {
            fromSocketId: socket.id,
            fromName: rooms[roomId].playerNamesById[socket.id] || 'Avversario',
            playerIdentity: payload.playerIdentity || null,
            modifierType: payload.modifierType,
            target: payload.target || null,
            stat: payload.stat || null,
            delta: payload.delta || 0,
            durationMatches: payload.durationMatches || 1,
            matchesRemaining: payload.matchesRemaining || 1,
            label: payload.label || '',
            silent: !!payload.silent
        });
        console.log(`[${roomId}] external-modifier ${payload.modifierType} from ${socket.id.slice(0,6)} → ${targetSocketId.slice(0,6)}${payload.playerIdentity ? ' (' + payload.playerIdentity + ')' : ''}`);
    });

    // ================================================================
    // SAVE / LOAD: salvataggio della partita su localStorage del client host
    // ================================================================
    // request-save-snapshot: il client host chiede lo snapshot COMPLETO della room per salvarlo
    socket.on('request-save-snapshot', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (socket.id !== room.hostSocketId) {
            console.log(`[${roomId}] request-save-snapshot rifiutato: non host`);
            return;
        }
        // Costruisco uno snapshot esteso, che include TUTTO ciò che serve a ricostruire la room
        const fullState = {
            // Posizioni / turni
            positions: { ...room.positions },
            playerNamesById: { ...room.playerNamesById },
            turnOrder: [...room.turnOrder],
            turnIndex: room.turnIndex,
            // Match state
            matchPhaseIds: Array.from(room.matchPhaseIds),
            matchActiveStartedIds: Array.from(room.matchActiveStartedIds),
            squads: JSON.parse(JSON.stringify(room.squads || {})),
            matchOpponents: { ...room.matchOpponents },
            matchScores: JSON.parse(JSON.stringify(room.matchScores || {})),
            standings: JSON.parse(JSON.stringify(room.standings || {})),
            pedineById: JSON.parse(JSON.stringify(room.pedineById || {})),
            // Settings
            hostSocketId: room.hostSocketId,
            gameMode: room.gameMode,
            playerMode: room.playerMode || 'virtual',
            gameStarted: room.gameStarted,
            bots: JSON.parse(JSON.stringify(room.bots || [])),
            botMatchdaysSimulated: room.botMatchdaysSimulated,
            cardFilters: JSON.parse(JSON.stringify(room.cardFilters || {})),
            realPlayerFilter: Array.isArray(room.realPlayerFilter) ? [...room.realPlayerFilter] : [],
            // Personal states (lap, abilities, totalDrawn, teamCount, mbappeCooldown, electricReflectionLog, ecc.)
            personalStates: JSON.parse(JSON.stringify(room.personalStates || {})),
            // Disconnected sockets (per ricostruire i giocatori offline al ripristino)
            disconnectedSockets: JSON.parse(JSON.stringify(room.disconnectedSockets || {})),
            // === COACHES: allenatore + coachSwitched + usedPersonIds + lap entrata per ogni giocatore ===
            coachesById: JSON.parse(JSON.stringify(room.coachesById || {})),
            // Helper: max giocate (per UI summary lato client)
            maxPlayed: maxUserPlayed(room)
        };
        socket.emit('save-snapshot-ready', { state: fullState });
        console.log(`[${roomId}] save-snapshot-ready inviato a host (${socket.id.slice(0,6)})`);
    });

    // load-save: il client (futuro host della nuova stanza) invia lo state salvato.
    // Il server applica tutto lo stato alla room, marca TUTTI i giocatori originali come
    // disconnessi (saranno ricollegati per nome quando rientrano), e migra il primo socketId
    // (host originale) al socket corrente del caricatore.
    socket.on('load-save', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) {
            socket.emit('load-save-error', { message: 'Stanza non trovata.' });
            return;
        }
        const room = rooms[roomId];
        const state = payload.state;
        if (!state || typeof state !== 'object') {
            socket.emit('load-save-error', { message: 'State non valido.' });
            return;
        }
        // Sicurezza: il caricatore deve essere host di questa stanza appena creata
        // (la stanza è appena stata creata da getRoom su join-room, e lui è il primo dentro)
        if (socket.id !== room.hostSocketId) {
            socket.emit('load-save-error', { message: 'Solo l\'host della stanza può caricare un salvataggio.' });
            return;
        }
        // Controllo: stanza appena creata, non deve avere già altri giocatori
        if (Object.keys(room.playerNamesById).length > 1) {
            socket.emit('load-save-error', { message: 'Carica un salvataggio in una stanza VUOTA (solo tu dentro).' });
            return;
        }
        try {
            // Nome del caricatore (host nuovo)
            const myName = room.playerNamesById[socket.id] || 'Manager';
            // === Applico stato salvato alla room (RIBASSANDO tutto) ===
            room.positions = state.positions || {};
            room.playerNamesById = state.playerNamesById || {};
            room.turnOrder = Array.isArray(state.turnOrder) ? state.turnOrder : [];
            room.turnIndex = Math.max(0, parseInt(state.turnIndex) || 0);
            room.matchPhaseIds = new Set(state.matchPhaseIds || []);
            room.matchActiveStartedIds = new Set(state.matchActiveStartedIds || []);
            room.squads = state.squads || {};
            room.matchOpponents = state.matchOpponents || {};
            room.matchScores = state.matchScores || {};
            room.standings = state.standings || {};
            room.pedineById = state.pedineById || {};
            // Storico match: ripristina da save (default: vuoto)
            room.matchHistoryById = (state.matchHistoryById && typeof state.matchHistoryById === 'object') ? state.matchHistoryById : {};
            room.botMatchHistoryById = (state.botMatchHistoryById && typeof state.botMatchHistoryById === 'object') ? state.botMatchHistoryById : {};
            room.gameMode = (state.gameMode === 'withBots') ? 'withBots' : 'noBot';
            room.playerMode = (state.playerMode === 'real') ? 'real' : 'virtual';
            room.gameStarted = !!state.gameStarted;
            room.bots = Array.isArray(state.bots) ? state.bots : [];
            room.botMatchdaysSimulated = parseInt(state.botMatchdaysSimulated) || 0;
            if (state.cardFilters && typeof state.cardFilters === 'object') {
                room.cardFilters = {
                    ability: Array.isArray(state.cardFilters.ability) ? state.cardFilters.ability : [],
                    specialPlayer: Array.isArray(state.cardFilters.specialPlayer) ? state.cardFilters.specialPlayer : [],
                    goal: Array.isArray(state.cardFilters.goal) ? state.cardFilters.goal : [],
                    enemy: Array.isArray(state.cardFilters.enemy) ? state.cardFilters.enemy : [],
                    bonus: Array.isArray(state.cardFilters.bonus) ? state.cardFilters.bonus : [],
                    imprevisto: Array.isArray(state.cardFilters.imprevisto) ? state.cardFilters.imprevisto : []
                };
            }
            room.personalStates = state.personalStates || {};
            room.disconnectedSockets = state.disconnectedSockets || {};
            // === Coach state + libreria reali da ripristinare ===
            room.coachesById = state.coachesById || {};
            room.realPlayerFilter = Array.isArray(state.realPlayerFilter) ? [...state.realPlayerFilter] : [];

            // === Identifico l'host originale del salvataggio ===
            // È il primo socketId in turnOrder (oppure quello con la flag personalStates...host? non c'è)
            // Strategia: se nel save c'è hostSocketId, lo uso. Altrimenti turnOrder[0].
            const originalHostId = state.hostSocketId || room.turnOrder[0] || null;

            // === Migrazione: rimpiazzo l'originalHostId con il socket.id del caricatore ===
            // Se trovo che il caricatore ha lo stesso nome di un giocatore qualsiasi nel save, lo migro su quello.
            // Altrimenti default: caricatore = originale host.
            let migrateFrom = null;
            const myNameLower = (myName || '').toLowerCase();
            Object.entries(room.playerNamesById).forEach(([sid, n]) => {
                if (sid !== socket.id && String(n || '').toLowerCase() === myNameLower) {
                    migrateFrom = sid;
                }
            });
            if (!migrateFrom) migrateFrom = originalHostId;

            if (migrateFrom && migrateFrom !== socket.id && migrateFrom in room.playerNamesById) {
                migratePlayerState(room, migrateFrom, socket.id);
                // Imposto host
                room.hostSocketId = socket.id;
            } else {
                // Caricatore non corrisponde a nessuno: lo aggiungo come nuovo player (rimane host)
                room.hostSocketId = socket.id;
                if (!room.playerNamesById[socket.id]) room.playerNamesById[socket.id] = myName;
                if (!room.turnOrder.includes(socket.id)) room.turnOrder.unshift(socket.id);
                if (!(socket.id in room.positions)) room.positions[socket.id] = 0;
            }

            // === SANITIZZAZIONE: rimuovi eventuali nomi duplicati in playerNamesById ===
            // Per ogni nome (case-insensitive), conservo SOLO una entry: priorità al socket.id
            // del caricatore (che dovrebbe essere già stato migrato), altrimenti la prima trovata.
            // Le entry duplicate vengono PULITE completamente (turnOrder, positions, squads, ecc.).
            const seenNames = new Map(); // nameLower → keepSocketId
            // Pre-popolo con il socketId del caricatore (priorità massima)
            if (room.playerNamesById[socket.id]) {
                seenNames.set(String(room.playerNamesById[socket.id]).toLowerCase(), socket.id);
            }
            const dupsToRemove = [];
            Object.entries(room.playerNamesById).forEach(([sid, name]) => {
                const nameLower = String(name || '').toLowerCase();
                if (!seenNames.has(nameLower)) {
                    seenNames.set(nameLower, sid);
                } else {
                    const keepSid = seenNames.get(nameLower);
                    if (sid !== keepSid) {
                        dupsToRemove.push(sid);
                    }
                }
            });
            // Cleanup completo delle entry duplicate
            dupsToRemove.forEach(sid => {
                delete room.playerNamesById[sid];
                delete room.positions[sid];
                delete room.squads[sid];
                delete room.matchOpponents[sid];
                delete room.matchScores[sid];
                delete room.standings[sid];
                delete room.pedineById[sid];
                delete room.personalStates[sid];
                delete room.disconnectedSockets[sid];
                room.matchPhaseIds.delete(sid);
                room.matchActiveStartedIds.delete(sid);
                const tIdx = room.turnOrder.indexOf(sid);
                if (tIdx >= 0) {
                    room.turnOrder.splice(tIdx, 1);
                    if (tIdx < room.turnIndex) room.turnIndex--;
                }
                // Rimuovi anche dalle assegnazioni avversario degli altri
                Object.keys(room.matchOpponents).forEach(id => {
                    if (room.matchOpponents[id] === sid) delete room.matchOpponents[id];
                });
            });
            if (dupsToRemove.length > 0) {
                console.log(`[${roomId}] load-save: rimosse ${dupsToRemove.length} entry duplicate per nome`);
            }

            // === Marca TUTTI gli altri (vecchi socketIds rimasti) come DISCONNESSI ===
            // E aggiungili a disconnectedPlayers per il reconnect-by-name
            if (!disconnectedPlayers[roomId]) disconnectedPlayers[roomId] = [];
            Object.entries(room.playerNamesById).forEach(([sid, name]) => {
                if (sid === socket.id) return; // io sono connesso
                room.disconnectedSockets[sid] = {
                    kicked: false,
                    since: Date.now(),
                    name: name
                };
                // Aggiungi a disconnectedPlayers per matching nome→socketId al reconnect
                disconnectedPlayers[roomId].push({
                    oldSocketId: sid,
                    name: name,
                    timestamp: Date.now()
                });
            });

            // === Avanza il turno se il turno corrente è su un giocatore disconnesso/finito ===
            // L'utente vuole "ripartire dal giocatore che aveva il turno al salvataggio",
            // ma se quello è disconnesso (probabile dato che solo il caricatore è online),
            // skippa al successivo come fa end-turn normalmente.
            const isFinished = (id) => {
                const st = room.standings[id];
                if (!st) return false;
                const played = (typeof st === 'object' && st !== null) ? (st.played || 0) : 0;
                return played >= MAX_MATCHDAYS;
            };
            const isDisconnected = (id) => !!(room.disconnectedSockets && room.disconnectedSockets[id]);
            const N = room.turnOrder.length;
            if (N > 0) {
                let curIdx = room.turnIndex;
                let currentTurnId = room.turnOrder[curIdx];
                // Se il turno corrente è invalido, cerca il prossimo valido
                if (!currentTurnId || isFinished(currentTurnId) || isDisconnected(currentTurnId)) {
                    let foundIdx = -1;
                    for (let i = 0; i < N; i++) {
                        curIdx = (curIdx + 1) % N;
                        const candidate = room.turnOrder[curIdx];
                        if (!candidate) continue;
                        if (!isFinished(candidate) && !isDisconnected(candidate)) {
                            foundIdx = curIdx;
                            break;
                        }
                    }
                    if (foundIdx >= 0) room.turnIndex = foundIdx;
                }
            }

            // Sync bot matchdays al play count corrente (i bot già contengono i loro played dal save)
            // Nessuna azione necessaria.

            // Notifica TUTTI nella room
            io.to(roomId).emit('state-updated', snapshot(room));
            // Notifica anche con room-joined-like per il caricatore (per ri-trigger UI)
            socket.emit('room-presence', snapshot(room));

            console.log(`[${roomId}] LOAD-SAVE applicato. Host=${myName} (${socket.id.slice(0,6)}). Disconnected: ${Object.keys(room.disconnectedSockets).length}`);
        } catch (e) {
            console.error('load-save error:', e);
            socket.emit('load-save-error', { message: 'Errore durante il caricamento: ' + (e.message || 'sconosciuto') });
        }
    });

    // MENU HOST: forza il passaggio del turno di un giocatore.
    // Solo l'host può chiamarlo. Il target deve essere il giocatore con il turno corrente.
    socket.on('host-force-pass-turn', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (socket.id !== room.hostSocketId) return; // solo l'host
        const targetId = payload.targetSocketId;
        if (!targetId || typeof targetId !== 'string') return;
        const currentTurnId = room.turnOrder[room.turnIndex] || null;
        // Tolleranza: se il target non ha più il turno corrente (race), passo comunque
        // dal turno corrente. L'host vuole solo "sbloccare" il gioco.
        const effectiveTarget = (targetId === currentTurnId) ? targetId : currentTurnId;
        if (!effectiveTarget) return;
        // Se il target era in match phase, lo rimuovo: forzare il passaggio del turno deve
        // farlo USCIRE da una partita potenzialmente bloccata. Il match attuale viene
        // considerato concluso ai fini del flow (lato client lui non vedrà nulla finché torna il turno).
        if (room.matchPhaseIds.has(effectiveTarget)) {
            room.matchPhaseIds.delete(effectiveTarget);
            room.matchActiveStartedIds.delete(effectiveTarget);
            // Lascio matchScores intatto: ai fini classifica conteranno se il match viene chiuso lato client
        }
        // Avanza il turno usando la stessa logica di end-turn (skip dei giocatori finiti)
        if (room.turnOrder.length > 0) {
            const isFinished = (id) => {
                const st = room.standings[id];
                if (!st) return false;
                const played = (typeof st === 'object' && st !== null) ? (st.played || 0) : 0;
                return played >= MAX_MATCHDAYS;
            };
            const isDisconnected = (id) => !!(room.disconnectedSockets && room.disconnectedSockets[id]);
            const N = room.turnOrder.length;
            let nextIdx = room.turnIndex;
            for (let i = 0; i < N; i++) {
                nextIdx = (nextIdx + 1) % N;
                const candidate = room.turnOrder[nextIdx];
                if (!candidate) continue;
                if (!isFinished(candidate) && !isDisconnected(candidate)) break;
            }
            room.turnIndex = nextIdx;
        }
        const nextId = room.turnOrder[room.turnIndex] || null;
        const hostName = room.playerNamesById[socket.id] || 'Host';
        const victimName = room.playerNamesById[effectiveTarget] || 'Giocatore';
        const statusText = `👑 ${hostName} ha forzato il passaggio del turno di ${victimName}.`;
        io.to(roomId).emit('turn-updated', { ...snapshot(room), statusText });
        // Notifico privatamente il target così il suo client esce dalla match phase locale
        io.to(effectiveTarget).emit('host-force-end-match', { byName: hostName });
        console.log(`[${roomId}] HOST FORCE-PASS-TURN: ${hostName} → ${victimName} | next: ${nextId ? nextId.slice(0,6) : 'nessuno'}`);
    });

    // MENU HOST: disconnetti un giocatore dalla partita.
    // Lo informa con 'you-were-kicked', poi forza il suo disconnect. La squadra/standings/abilità
    // restano salvate nello stato della room (come per un disconnect normale con grace period).
    socket.on('host-kick-player', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (socket.id !== room.hostSocketId) return; // solo l'host
        const targetId = payload.targetSocketId;
        if (!targetId || typeof targetId !== 'string') return;
        if (targetId === socket.id) return; // l'host non può kickare se stesso
        if (!room.playerNamesById[targetId]) return;
        const hostName = room.playerNamesById[socket.id] || 'Host';
        const victimName = room.playerNamesById[targetId] || 'Giocatore';
        console.log(`[${roomId}] HOST KICK: ${hostName} → ${victimName} (${targetId.slice(0,6)})`);
        // Notifica il target (gli si mostrerà il modal "sei stato espulso")
        io.to(targetId).emit('you-were-kicked', { byName: hostName });
        // Marca esplicitamente questo socket come "kicked" così il suo disconnect-handler
        // potrà comportarsi diversamente (vedi disconnect logic + skip-turn server-side)
        if (!room.disconnectedSockets) room.disconnectedSockets = {};
        room.disconnectedSockets[targetId] = { kicked: true, since: Date.now(), name: victimName };
        // Notifica gli altri della disconnessione imminente
        io.to(roomId).emit('player-kicked-broadcast', { kickedId: targetId, kickedName: victimName, byName: hostName });
        // Force-disconnect il socket: il client riceverà già 'you-were-kicked' prima.
        // Aspettiamo un tick per consentire al client di mostrare il modal, poi tagliamo la connessione.
        setTimeout(() => {
            const sock = io.sockets.sockets.get(targetId);
            if (sock) { try { sock.disconnect(true); } catch (e) {} }
        }, 200);
    });

    // VAR SABOTATO (carta abilità A26): togli 1 gol al giocatore che sta giocando attivamente il match.
    // Solo chi NON ha il turno può scatenarlo, e solo se il target ha gol > 0.
    socket.on('steal-goal', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const targetSocketId = payload.targetSocketId;
        if (!targetSocketId || typeof targetSocketId !== 'string') return;
        // Validazioni server-side: chi attiva NON deve essere il turno corrente
        const currentTurnId = room.turnOrder[room.turnIndex] || null;
        if (socket.id === currentTurnId) return; // un giocatore al proprio turno NON può usarla
        // Il target deve essere il giocatore di turno (cioè chi sta giocando attivamente)
        if (targetSocketId !== currentTurnId) return;
        // Il target deve avere gol > 0 nel match in corso
        const sc = room.matchScores[targetSocketId];
        if (!sc || !sc.own || sc.own <= 0) return;
        sc.own = Math.max(0, sc.own - 1);
        const stealerName = room.playerNamesById[socket.id] || 'Avversario';
        const victimName = room.playerNamesById[targetSocketId] || 'Avversario';
        console.log(`[${roomId}] steal-goal: ${stealerName} (${socket.id.slice(0,6)}) ha tolto 1 gol a ${victimName} (${targetSocketId.slice(0,6)})`);
        io.to(roomId).emit('state-updated', snapshot(room));
        // Inoltro al target una notifica privata
        io.to(targetSocketId).emit('goal-stolen-notice', {
            fromName: stealerName,
            newOwn: sc.own
        });
    });

    // GIGANTE ELETTRICO: il proprietario di Gigante vince un duello → applica un malus
    // permanente sul calciatore avversario perdente. Il server fa solo da relay verso il target.
    socket.on('electric-reflect', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const targetSocketId = payload.targetSocketId;
        if (!targetSocketId || typeof targetSocketId !== 'string') return;
        // Sanity check sui campi
        const playerIdentity = typeof payload.playerIdentity === 'string' ? payload.playerIdentity.slice(0, 80) : '';
        const statUsed = typeof payload.statUsed === 'string' ? payload.statUsed.slice(0, 20) : '';
        const malus = parseInt(payload.malus);
        if (!playerIdentity || !statUsed) return;
        if (!Number.isFinite(malus) || malus >= 0 || malus < -50) return;
        const applicationIdx = typeof payload.applicationIdx === 'string' ? payload.applicationIdx.slice(0, 60) : ('app_' + Date.now());
        io.to(targetSocketId).emit('electric-apply', {
            fromSocketId: socket.id,
            playerIdentity,
            statUsed,
            malus,
            applicationIdx
        });
        console.log(`[${roomId}] electric-reflect ${socket.id.slice(0,6)} → ${targetSocketId.slice(0,6)} (${playerIdentity}, ${statUsed} ${malus})`);
    });

    // HELLO NEIGHBOR: relay capture verso il target (chi possiede il giocatore catturato)
    socket.on('hello-neighbor-capture', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const targetSocketId = payload.targetSocketId;
        if (!targetSocketId || typeof targetSocketId !== 'string') return;
        const playerIdentity = typeof payload.playerIdentity === 'string' ? payload.playerIdentity.slice(0, 80) : '';
        const byName = typeof payload.byName === 'string' ? payload.byName.slice(0, 40) : 'Hello Neighbor';
        if (!playerIdentity) return;
        io.to(targetSocketId).emit('hello-neighbor-apply', {
            fromSocketId: socket.id,
            playerIdentity,
            byName
        });
        console.log(`[${roomId}] hello-neighbor-capture ${socket.id.slice(0,6)} → ${targetSocketId.slice(0,6)} (${playerIdentity})`);
    });

    // Messaggio aggregato per "La piaga di Milik": il target riceve un singolo modal con tutti i calciatori infortunati
    socket.on('milik-aggregate-msg', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const targetSocketId = payload.targetSocketId;
        if (!targetSocketId) return;
        const fromName = rooms[roomId].playerNamesById[socket.id] || 'Avversario';
        // Sanitize targets: array di {identity, duration}
        const targets = Array.isArray(payload.targets)
            ? payload.targets.slice(0, 4).map(t => ({
                identity: typeof t.identity === 'string' ? t.identity.slice(0, 60) : '',
                duration: Math.max(1, Math.min(3, parseInt(t.duration) || 1))
            })).filter(t => t.identity)
            : [];
        if (!targets.length) return;
        io.to(targetSocketId).emit('milik-attack-received', {
            fromSocketId: socket.id,
            fromName: fromName,
            cardTitle: typeof payload.cardTitle === 'string' ? payload.cardTitle.slice(0, 80) : 'La piaga di Milik',
            targets: targets
        });
        console.log(`[${roomId}] milik-aggregate from ${fromName} → ${targetSocketId.slice(0,6)} (${targets.length} infortuni)`);
    });

    // Broadcast pesca BONUS / IMPREVISTO / ABILITÀ + uso ABILITÀ (visibili a tutti gli spectator)
    socket.on('bonus-draw', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        socket.broadcast.to(roomId).emit('bonus-draw-broadcast', {
            drawerSocketId: socket.id,
            drawerName: rooms[roomId].playerNamesById[socket.id] || 'Avversario',
            card: payload.card,
            isPreMatch: payload.isPreMatch
        });
    });

    socket.on('imprevisto-draw', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        socket.broadcast.to(roomId).emit('imprevisto-draw-broadcast', {
            drawerSocketId: socket.id,
            drawerName: rooms[roomId].playerNamesById[socket.id] || 'Avversario',
            card: payload.card,
            isPreMatch: payload.isPreMatch
        });
    });

    socket.on('ability-draw', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        socket.broadcast.to(roomId).emit('ability-draw-broadcast', {
            drawerSocketId: socket.id,
            drawerName: rooms[roomId].playerNamesById[socket.id] || 'Avversario',
            card: payload.card
        });
    });

    socket.on('ability-use', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        socket.broadcast.to(roomId).emit('ability-use-broadcast', {
            userSocketId: socket.id,
            userName: rooms[roomId].playerNamesById[socket.id] || 'Avversario',
            card: payload.card,
            summary: payload.summary || ''
        });
    });

    // Abilità "Sorteggio Favorevole" REVISED: il client sceglie manualmente il nuovo avversario.
    // Mantiene lo score corrente; cambia solo matchOpponents[me] = newId.
    socket.on('pick-opponent', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const newId = payload.newOpponentId;
        if (!newId || newId === socket.id) return;
        if (!room.playerNamesById[newId]) return; // non esiste in stanza
        if (!room.matchPhaseIds.has(socket.id)) return; // non sono in match phase
        // Non si può scegliere un giocatore disconnesso
        if (room.disconnectedSockets && room.disconnectedSockets[newId]) return;
        room.matchOpponents[socket.id] = newId;
        // Lo score corrente in matchScores[socket.id] resta invariato.
        // Memorizza per il prossimo match (lastOpponentId)
        if (!room.personalStates[socket.id]) room.personalStates[socket.id] = {};
        room.personalStates[socket.id].lastOpponentId = newId;
        io.to(roomId).emit('state-updated', snapshot(room));
        console.log(`[${roomId}] pick-opponent ${socket.id.slice(0,6)} → ${newId.slice(0,6)}`);
    });

    // Abilità "Sorteggio Favorevole" (vecchio): ri-sorteggia l'avversario assegnato
    socket.on('reassign-opponent', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const currentOpp = room.matchOpponents[socket.id];
        const isDisconnected = (id) => !!(room.disconnectedSockets && room.disconnectedSockets[id]);
        // Esclude me, l'attuale opp e i disconnessi
        const candidates = Object.keys(room.playerNamesById)
            .filter(id => id !== socket.id && id !== currentOpp && !isDisconnected(id));
        if (!candidates.length) return;
        room.matchOpponents[socket.id] = candidates[Math.floor(Math.random() * candidates.length)];
        io.to(roomId).emit('state-updated', snapshot(room));
        console.log(`[${roomId}] reassign-opp ${socket.id.slice(0,6)} → ${room.matchOpponents[socket.id].slice(0,6)}`);
    });

    socket.on('end-turn', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (room.turnOrder.length > 0) {
            // Determina se un giocatore ha già completato il campionato (38 giornate).
            const isFinished = (id) => {
                const st = room.standings[id];
                if (!st) return false;
                const played = (typeof st === 'object' && st !== null) ? (st.played || 0) : 0;
                return played >= MAX_MATCHDAYS;
            };
            // È disconnesso (kicked o offline ma ancora presente in turnOrder)?
            const isDisconnected = (id) => !!(room.disconnectedSockets && room.disconnectedSockets[id]);
            // Avanza l'indice almeno una volta, poi salta i giocatori finiti e disconnessi.
            const N = room.turnOrder.length;
            let nextIdx = room.turnIndex;
            for (let i = 0; i < N; i++) {
                nextIdx = (nextIdx + 1) % N;
                const candidate = room.turnOrder[nextIdx];
                if (!candidate) continue;
                if (!isFinished(candidate) && !isDisconnected(candidate)) break;
            }
            room.turnIndex = nextIdx;
        }
        const nextId = room.turnOrder[room.turnIndex] || null;
        io.to(roomId).emit('turn-updated', {
            ...snapshot(room),
            statusText: payload.statusText || ''
        });
        console.log(`[${roomId}] turno -> ${nextId ? nextId.slice(0, 6) : 'nessuno'}`);
    });

    socket.on('disconnect', () => {
        if (!joinedRoomId || !rooms[joinedRoomId]) return;
        const room = rooms[joinedRoomId];
        const name = room.playerNamesById[socket.id];
        if (!name) return; // gia' rimosso

        // === GRACE PERIOD: salva lo stato del giocatore per RECONNECT_GRACE_MS ===
        // NON cancello immediatamente position/pedina/squad/standings: aspetto il reconnect.
        // Salvo solo le info utili per la migrazione + il timestamp.
        if (!disconnectedPlayers[joinedRoomId]) disconnectedPlayers[joinedRoomId] = [];
        disconnectedPlayers[joinedRoomId].push({
            oldSocketId: socket.id,
            name: name,
            timestamp: Date.now()
        });
        const capturedRoomId = joinedRoomId;
        const capturedSocketId = socket.id;
        console.log(`[${capturedRoomId}] DISCONNECT ${name} (${capturedSocketId.slice(0,6)}) — grace period ${RECONNECT_GRACE_MS/1000}s`);

        // Marca il giocatore come disconnesso → il turno verrà SKIPPATO automaticamente
        // finché non si riconnette. Squadra/standings/abilità restano salvate.
        const alreadyKicked = !!(room.disconnectedSockets && room.disconnectedSockets[capturedSocketId]);
        if (!room.disconnectedSockets) room.disconnectedSockets = {};
        room.disconnectedSockets[capturedSocketId] = {
            kicked: alreadyKicked ? true : false,
            since: Date.now(),
            name: name
        };
        // Allinea SUBITO il disconnesso alle giornate giocate dai connessi (simulazione bot-like)
        try { syncDisconnectedPlayersMatchdays(room); } catch (e) {}
        // Se era l'avversario del match di qualcuno → annullo l'assegnazione, gli altri sceglieranno nuovo opp
        Object.keys(room.matchOpponents).forEach(playerId => {
            if (room.matchOpponents[playerId] === capturedSocketId) {
                delete room.matchOpponents[playerId];
            }
        });

        // Se era il suo turno, salta subito al prossimo giocatore non-finito + non-disconnesso
        const wasCurrentTurn = room.turnOrder[room.turnIndex] === capturedSocketId;
        if (wasCurrentTurn) {
            const isFinished = (id) => {
                const st = room.standings[id];
                if (!st) return false;
                const played = (typeof st === 'object' && st !== null) ? (st.played || 0) : 0;
                return played >= MAX_MATCHDAYS;
            };
            const isDisconnected = (id) => !!(room.disconnectedSockets && room.disconnectedSockets[id]);
            const N = room.turnOrder.length;
            let nextIdx = room.turnIndex;
            for (let i = 0; i < N; i++) {
                nextIdx = (nextIdx + 1) % N;
                const candidate = room.turnOrder[nextIdx];
                if (!candidate) continue;
                if (!isFinished(candidate) && !isDisconnected(candidate)) break;
            }
            room.turnIndex = nextIdx;
            io.to(capturedRoomId).emit('turn-updated', {
                ...snapshot(room),
                statusText: `${name} si è disconnesso, il turno passa automaticamente.`
            });
        }

        // === HOST TRANSFER IMMEDIATO ===
        // Se l'host si disconnette, trasferisco SUBITO l'host al primo giocatore in turnOrder
        // che NON sia lui stesso e che NON sia disconnesso. Così la stanza non resta senza host
        // anche durante il grace period (30 min).
        if (room.hostSocketId === capturedSocketId) {
            const isDisconnected = (id) => !!(room.disconnectedSockets && room.disconnectedSockets[id]);
            // Cerco il primo non-disconnesso nell'ordine turni (escluso l'host che sta uscendo)
            let newHost = null;
            for (let i = 0; i < room.turnOrder.length; i++) {
                const candidate = room.turnOrder[i];
                if (!candidate || candidate === capturedSocketId) continue;
                if (!isDisconnected(candidate) && room.playerNamesById[candidate]) {
                    newHost = candidate;
                    break;
                }
            }
            if (newHost) {
                room.hostSocketId = newHost;
                const newHostName = room.playerNamesById[newHost] || newHost.slice(0,6);
                console.log(`[${capturedRoomId}] 👑 HOST TRANSFER: ${name} → ${newHostName} (host originale disconnesso)`);
                // Notifica privatamente il nuovo host che è promosso
                io.to(newHost).emit('host-promoted', {
                    fromName: name,
                    reason: 'disconnect'
                });
            } else {
                console.log(`[${capturedRoomId}] HOST disconnesso ma nessun altro giocatore connesso disponibile`);
            }
        }
        io.to(capturedRoomId).emit('room-presence', snapshot(room));

        // === Timer grace period: dopo RECONNECT_GRACE_MS, rimuovo davvero il giocatore ===
        setTimeout(() => {
            // Verifica che non si sia riconnesso nel frattempo (in tal caso disconnectedPlayers
            // sarebbe già stato pulito via migratePlayerState)
            const arr = disconnectedPlayers[capturedRoomId] || [];
            const stillThere = arr.find(d => d.oldSocketId === capturedSocketId);
            if (!stillThere) return; // riconnesso → niente da fare

            // Rimuovo dall'array dei disconnessi
            disconnectedPlayers[capturedRoomId] = arr.filter(d => d.oldSocketId !== capturedSocketId);

            const r = rooms[capturedRoomId];
            if (!r) return;

            // Cleanup completo dello stato
            const tIdx = r.turnOrder.indexOf(capturedSocketId);
            if (tIdx >= 0) {
                r.turnOrder.splice(tIdx, 1);
                if (tIdx < r.turnIndex) r.turnIndex--;
            }
            delete r.positions[capturedSocketId];
            delete r.playerNamesById[capturedSocketId];
            r.matchPhaseIds.delete(capturedSocketId);
            r.matchActiveStartedIds.delete(capturedSocketId);
            delete r.squads[capturedSocketId];
            delete r.matchOpponents[capturedSocketId];
            delete r.matchScores[capturedSocketId];
            delete r.pedineById[capturedSocketId];
            if (r.disconnectedSockets) delete r.disconnectedSockets[capturedSocketId];
            // standings: tengo (storico classifica)

            if (r.turnIndex >= r.turnOrder.length) r.turnIndex = 0;

            // Host transfer se serve
            if (r.hostSocketId === capturedSocketId) {
                r.hostSocketId = r.turnOrder[0] || null;
                console.log(`[${capturedRoomId}] host trasferito a ${r.hostSocketId ? r.hostSocketId.slice(0,6) : 'nessuno'}`);
            }

            // Stanza vuota: tienila per ROOM_EMPTY_GRACE_MS prima di eliminare
            if (r.turnOrder.length === 0) {
                if (!roomEmptySince[capturedRoomId]) roomEmptySince[capturedRoomId] = Date.now();
                setTimeout(() => {
                    if (rooms[capturedRoomId] && rooms[capturedRoomId].turnOrder.length === 0
                        && roomEmptySince[capturedRoomId]
                        && (Date.now() - roomEmptySince[capturedRoomId] >= ROOM_EMPTY_GRACE_MS)) {
                        delete rooms[capturedRoomId];
                        delete roomEmptySince[capturedRoomId];
                        delete disconnectedPlayers[capturedRoomId];
                        console.log(`[${capturedRoomId}] stanza vuota da 5 min, eliminata.`);
                    }
                }, ROOM_EMPTY_GRACE_MS + 500);
            } else {
                // Lobby con bot: ribilancia per riempire i posti liberi
                if (!r.gameStarted && r.gameMode === 'withBots') {
                    rebalanceBotsInLobby(r);
                }
                io.to(capturedRoomId).emit('room-presence', snapshot(r));
            }
            console.log(`[${capturedRoomId}] FINAL CLEANUP ${name} (${capturedSocketId.slice(0, 6)}) — rimasti: ${r.turnOrder.length}`);
        }, RECONNECT_GRACE_MS);
    });
});

// --- Avvio server ---
server.listen(PORT, () => {
    console.log('\n⚽  Cortomusopoly — server multiplayer attivo');
    console.log('   Versione servita: ' + DEFAULT_VERSION);
    console.log('   Locale:           http://localhost:' + PORT);

    const nets = os.networkInterfaces();
    const lanIps = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
            if (net.family === 'IPv4' && !net.internal) lanIps.push(net.address);
        }
    }
    if (lanIps.length) {
        console.log('   Rete locale:      http://' + lanIps[0] + ':' + PORT + '  (PC, telefoni sulla stessa WiFi)');
    }
    console.log('\n   Apri 2 tab del browser su localhost per simulare 2 giocatori.');
    console.log('   CTRL+C per fermare il server.\n');
});
