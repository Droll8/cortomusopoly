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
const DEFAULT_VERSION = '16.0';
const VERSIONS_DIR = path.join(__dirname, 'VERSIONI');
const AUDIO_DIR = __dirname; // Gli mp3 di sottofondo stanno nella root del progetto

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingInterval: 20000,   // ping ogni 20s (default 25s)
    pingTimeout: 25000,    // timeout disconnessione 25s (default 20s)
    transports: ['websocket', 'polling']
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
    for (const bot of room.bots) {
        const r = generateBotMatchResult();
        bot.stats.played++;
        bot.stats.gf += r.own;
        bot.stats.gs += r.opp;
        if (r.own > r.opp) { bot.stats.pt += 3; bot.stats.w++; }
        else if (r.own === r.opp) { bot.stats.pt += 1; bot.stats.d++; }
        else { bot.stats.l++; }
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
    ids.forEach(socketId => {
        // Se nel frattempo è uscito da disconnectedSockets (riconnesso), skip
        if (!room.disconnectedSockets[socketId]) return;
        ensureUserStats(room, socketId);
        const s = room.standings[socketId];
        let simulated = 0;
        while ((s.played || 0) < cap && (s.played || 0) < MAX_MATCHDAYS) {
            const r = generateBotMatchResult();
            s.played++;
            s.gf += r.own;
            s.gs += r.opp;
            if (r.own > r.opp) { s.pt += 3; s.w++; }
            else if (r.own === r.opp) { s.pt += 1; s.d++; }
            else { s.l++; }
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
            // === Giocatori marcati come "disconnessi" (host kick o disconnect normale).
            // socketId → { kicked: bool, since: ts, name: '...' }
            // Mentre sono qui dentro, il loro turno viene SKIPPATO automaticamente nel turn-rotation.
            // Vengono ripuliti al reconnect.
            disconnectedSockets: {}
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
        coachesById: JSON.parse(JSON.stringify(room.coachesById || {}))
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

        // === RECONNECT DETECTION ===
        // Se nel grace period esiste un disconnect recente con lo stesso nome → migra lo stato
        const recentArr = disconnectedPlayers[roomId] || [];
        const reconnectEntry = recentArr.find(d =>
            d.name === safeName && (Date.now() - d.timestamp) < RECONNECT_GRACE_MS
        );
        let reconnected = false;
        if (reconnectEntry) {
            const oldId = reconnectEntry.oldSocketId;
            // Rimuovi il vecchio nome (era ancora in playerNamesById se non scaduto il grace)
            delete room.playerNamesById[oldId];
            migratePlayerState(room, oldId, socket.id);
            disconnectedPlayers[roomId] = recentArr.filter(d => d.oldSocketId !== oldId);
            reconnected = true;
            console.log(`[${roomId}] RECONNECT ${safeName} (${oldId.slice(0,6)} → ${socket.id.slice(0,6)})`);
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
        room.coachesById[socket.id] = {
            coachId,
            coachSwitched,
            coachStartedAtLap,
            coachUsedPersonIds: usedPersonIds
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
        // === Bot: se la modalità è "withBots", sincronizza la simulazione delle giornate
        // (i bot simulano UNA giornata ogni volta che il MAX di played aumenta — cap a 38)
        if (room.gameMode === 'withBots' && room.bots.length > 0) {
            syncBotMatchdays(room);
        }
        // === Disconnessi: simulano le loro giornate come i bot finché restano disconnessi.
        // Questo li mantiene allineati alla classifica e impedisce che restino indietro.
        syncDisconnectedPlayersMatchdays(room);
        io.to(roomId).emit('state-updated', snapshot(room));
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
            // Personal states (lap, abilities, totalDrawn, teamCount, mbappeCooldown, electricReflectionLog, ecc.)
            personalStates: JSON.parse(JSON.stringify(room.personalStates || {})),
            // Disconnected sockets (per ricostruire i giocatori offline al ripristino)
            disconnectedSockets: JSON.parse(JSON.stringify(room.disconnectedSockets || {})),
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
