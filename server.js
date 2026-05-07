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
const DEFAULT_VERSION = '11.0';
const VERSIONS_DIR = path.join(__dirname, 'VERSIONI');
const AUDIO_DIR = __dirname; // Gli mp3 di sottofondo stanno nella root del progetto

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Servizio file HTML ---
function serveVersion(version, res) {
    const filePath = path.join(VERSIONS_DIR, version + '.txt');
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            res.status(404).send(`<h1>Versione ${version} non trovata</h1><p>${err.message}</p>`);
            return;
        }
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(data);
    });
}

app.get('/', (req, res) => serveVersion(DEFAULT_VERSION, res));
app.get('/v/:version', (req, res) => serveVersion(req.params.version, res));

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
            'Cache-Control': 'public, max-age=86400'
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
            }
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
        }
    };
}

function sanitizeRoomId(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function sanitizeName(value) {
    return String(value || 'Manager').replace(/[^\wÀ-ÿ\s-]/g, '').trim().slice(0, 24) || 'Manager';
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
        const isFirst = Object.keys(room.playerNamesById).length === 0;
        room.playerNamesById[socket.id] = safeName;
        if (!(socket.id in room.positions)) room.positions[socket.id] = 0;
        if (!room.turnOrder.includes(socket.id)) room.turnOrder.push(socket.id);

        // Se è la prima persona della stanza (e non c'è ancora host), questo utente diventa host
        if (!room.hostSocketId || isFirst) {
            room.hostSocketId = socket.id;
        }

        // Se la partita è già iniziata in modalità con bot e ci sono bot disponibili,
        // l'utente entrato sostituisce il bot ULTIMO in classifica ed eredita le sue stats
        if (room.gameStarted && room.gameMode === 'withBots' && room.bots.length > 0) {
            replaceLastBotWithUser(room, socket.id);
        } else if (!room.gameStarted && room.gameMode === 'withBots') {
            // Lobby in modalità con bot: ribilancia (rimuove eventuali bot in eccesso)
            rebalanceBotsInLobby(room);
        }

        const snap = snapshot(room);
        socket.emit('room-joined', snap);
        socket.to(roomId).emit('room-presence', snap);

        console.log(`[${roomId}] + ${safeName} (${socket.id.slice(0, 6)})${isFirst ? ' [HOST]' : ''} — totale: ${room.turnOrder.length}`);
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
            // Assegna avversario casuale (escluso me stesso)
            const candidates = Object.keys(room.playerNamesById).filter(id => id !== socket.id);
            if (candidates.length > 0) {
                room.matchOpponents[socket.id] = candidates[Math.floor(Math.random() * candidates.length)];
                room.matchScores[socket.id] = { own: 0, opp: 0 };
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
            label: payload.label || ''
        });
        console.log(`[${roomId}] external-modifier ${payload.modifierType} from ${socket.id.slice(0,6)} → ${targetSocketId.slice(0,6)}${payload.playerIdentity ? ' (' + payload.playerIdentity + ')' : ''}`);
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

    // Abilità "Sorteggio Favorevole": ri-sorteggia l'avversario assegnato
    socket.on('reassign-opponent', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const currentOpp = room.matchOpponents[socket.id];
        const candidates = Object.keys(room.playerNamesById).filter(id => id !== socket.id && id !== currentOpp);
        if (!candidates.length) return; // niente da fare se l'unico altro è già l'opp
        room.matchOpponents[socket.id] = candidates[Math.floor(Math.random() * candidates.length)];
        io.to(roomId).emit('state-updated', snapshot(room));
        console.log(`[${roomId}] reassign-opp ${socket.id.slice(0,6)} → ${room.matchOpponents[socket.id].slice(0,6)}`);
    });

    socket.on('end-turn', (payload = {}) => {
        const roomId = sanitizeRoomId(payload.roomId) || joinedRoomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (room.turnOrder.length > 0) {
            room.turnIndex = (room.turnIndex + 1) % room.turnOrder.length;
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
        const wasCurrentTurn = room.turnOrder[room.turnIndex] === socket.id;
        const idx = room.turnOrder.indexOf(socket.id);
        if (idx >= 0) {
            room.turnOrder.splice(idx, 1);
            if (idx < room.turnIndex) room.turnIndex--;
        }
        delete room.positions[socket.id];
        delete room.playerNamesById[socket.id];
        room.matchPhaseIds.delete(socket.id);
        room.matchActiveStartedIds.delete(socket.id);
        delete room.squads[socket.id];
        delete room.matchOpponents[socket.id];
        delete room.matchScores[socket.id];
        delete room.pedineById[socket.id];
        // standings: le tengo (storico classifica). Verranno azzerate alla creazione di una nuova stanza.

        if (room.turnOrder.length === 0) {
            delete rooms[joinedRoomId];
            console.log(`[${joinedRoomId}] stanza vuota, eliminata.`);
            return;
        }
        if (room.turnIndex >= room.turnOrder.length) room.turnIndex = 0;

        // Trasferisci host al primo nel turnOrder se quello che si è disconnesso era host
        if (room.hostSocketId === socket.id) {
            room.hostSocketId = room.turnOrder[0] || null;
            console.log(`[${joinedRoomId}] host trasferito a ${room.hostSocketId ? room.hostSocketId.slice(0,6) : 'nessuno'}`);
        }

        // Lobby con bot: ribilancia per riempire i posti liberi (utente disconnesso → +1 bot)
        if (!room.gameStarted && room.gameMode === 'withBots') {
            rebalanceBotsInLobby(room);
        }

        const snap = snapshot(room);
        io.to(joinedRoomId).emit('room-presence', snap);
        if (wasCurrentTurn) {
            io.to(joinedRoomId).emit('turn-updated', {
                ...snap,
                statusText: 'Turno passato automaticamente (giocatore disconnesso)'
            });
        }
        console.log(`[${joinedRoomId}] - ${socket.id.slice(0, 6)} — rimasti: ${room.turnOrder.length}`);
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
