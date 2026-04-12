const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock, GoalNear, GoalFollow } } = require('mineflayer-pathfinder');
const { plugin: collectblock } = require('mineflayer-collectblock');
const { plugin: movementPlugin } = require('mineflayer-movement');
const Vec3 = require('vec3');
const fs = require('fs');
const readline = require('readline');
const skillEngine = require('./skill-engine');

const BOT_USERNAME = 'NILO';
const MASTER = 'PrizmoElectric'; // owner — change here if username ever changes
const HOST = 'localhost';
const PORT = 25565;
const MC_VERSION = '1.20.1';
const LETTA_URL = 'http://localhost:8283/v1/agents/agent-9fb13e9e-f9ce-4802-b90d-ffb5eceb5434/messages';
const LOG_PATH = '/home/prizmo/mc-prominence2/data/logs/latest.log';
const CONFIG_PATH = '/home/prizmo/nilo/config.json';

// Mature crop states: block name -> required metadata/age
const MATURE_CROPS = {
  'wheat':    { age: 7 },
  'carrots':  { age: 7 },
  'potatoes': { age: 7 },
  'beetroots':{ age: 3 },
};

// Minecraft death message verbs — matches "<player> <verb> ..."
const DEATH_VERBS = /^(.+?) (was slain|was shot|was killed|was blown up|was poked|was impaled|was stung|was fireballed|drowned|burned to death|blew up|fell from|fell off|fell out|fell into|fell while|hit the ground|flew into|went up in flames|walked into|died|starved to death|suffocated|was struck by lightning|froze to death|was squished|tried to swim in lava|discovered the floor|experienced kinetic energy)/;
const ADVANCEMENT_RE = /^(.+?) has (made the advancement|completed the challenge|reached the goal) \[(.+?)\]/;
const JOIN_RE = /^(.+?) joined the game$/;
const LEAVE_RE = /^(.+?) left the game$/;

let activeBotRef = null;
let isFarming = false;
let proximityInterval = null;
let autonomousInterval = null;
let exploringEnabled = true;
let isLooting = false;
let lastInteractionTime = 0;
let justDied = false;
let behaviorOwner = null; // who issued the current behavior command
let autonomousSkillsEnabled = false; // opt-in: !nilo autonomous on/off
let skillLearnInProgress = false;    // prevent concurrent learn jobs
const CONVERSATION_WINDOW_MS = 30000; // 30s after last interaction, no trigger needed
const PROXIMITY_CHAT_RANGE = 12;      // blocks — within this range, no trigger needed

// Prepend a [NEW SESSION] hint if the last real interaction was >5 min ago,
// to stop Letta bleeding old memory topics into proactive events.
function sessionHintFor(username) {
  const fresh = lastInteractionTime === 0 || (Date.now() - lastInteractionTime) > 300000;
  return fresh ? `[NEW SESSION — respond only to the current event, do not reference past conversations unprompted]\n` : '';
}

// ── Behavior state ────────────────────────────────────────────────────────────
// mode: idle | follow | wander | sit | attack | defensive | passive
let behaviorMode = 'idle';
let behaviorInterval = null;

function clearBehavior(bot) {
  if (behaviorInterval) {
    if (typeof behaviorInterval._cleanup === 'function') {
      behaviorInterval._cleanup(); // listener-based cleanup (mineflayer-movement)
    } else {
      clearInterval(behaviorInterval);
    }
    behaviorInterval = null;
  }
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  behaviorOwner = null;
}

function setBehavior(bot, mode, username) {
  clearBehavior(bot);
  behaviorMode = mode;
  behaviorOwner = username || null;
  console.log(`[NILO] Behavior -> ${mode}${username ? ` (for ${username})` : ''}`);
}

// ── Config (farm/chest coords, persisted to disk) ────────────────────────────

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function isTrusted(username) {
  if (username === MASTER) return true;
  const cfg = loadConfig();
  return (cfg.trusted || []).includes(username);
}

function trustPlayer(username) {
  const cfg = loadConfig();
  cfg.trusted = [...new Set([...(cfg.trusted || []), username])];
  saveConfig(cfg);
}

function untrustPlayer(username) {
  const cfg = loadConfig();
  cfg.trusted = (cfg.trusted || []).filter(n => n !== username);
  saveConfig(cfg);
}

// ── Log watcher ───────────────────────────────────────────────────────────────

function watchLog() {
  let fileSize = 0;
  try { fileSize = fs.statSync(LOG_PATH).size; } catch (_) {}

  fs.watchFile(LOG_PATH, { interval: 1000 }, (curr) => {
    if (curr.size <= fileSize) {
      fileSize = curr.size;
      return;
    }

    const stream = fs.createReadStream(LOG_PATH, { start: fileSize, end: curr.size - 1 });
    fileSize = curr.size;

    const rl = readline.createInterface({ input: stream });
    rl.on('line', (line) => {
      const infoMatch = line.match(/\[Server thread\/INFO\]: (.+)$/);
      if (!infoMatch) return;
      handleLogEvent(infoMatch[1]);
    });
  });

  console.log(`[NILO] Watching log: ${LOG_PATH}`);
}

function handleLogEvent(payload) {
  const bot = activeBotRef;
  if (!bot) return;

  let eventMsg = null;

  const joinMatch = payload.match(JOIN_RE);
  if (joinMatch && joinMatch[1] !== BOT_USERNAME) {
    eventMsg = `[SERVER EVENT] ${joinMatch[1]} joined the server.`;
  }

  const leaveMatch = payload.match(LEAVE_RE);
  if (leaveMatch && leaveMatch[1] !== BOT_USERNAME) {
    eventMsg = `[SERVER EVENT] ${leaveMatch[1]} left the server.`;
  }

  const deathMatch = payload.match(DEATH_VERBS);
  if (deathMatch && deathMatch[1] !== BOT_USERNAME) {
    eventMsg = `[SERVER EVENT] Death message: "${payload}"`;
  }

  const advMatch = payload.match(ADVANCEMENT_RE);
  if (advMatch) {
    eventMsg = `[SERVER EVENT] ${advMatch[1]} earned the advancement "${advMatch[3]}".`;
  }

  if (!eventMsg) return;

  console.log(`[NILO] Log event: ${eventMsg}`);
  queryLetta(sessionHintFor('') + eventMsg + '\n[Respond in: en]')
    .then((response) => { const { text } = parseAction(response); console.log(`[NILO] -> ${text}`); if (text) bot.chat(text); })
    .catch((err) => { console.error('[NILO] Letta error on log event:', err.message); });
}

// ── Farming ───────────────────────────────────────────────────────────────────

async function runFarm(bot) {
  if (isFarming) {
    bot.chat('Already farming. Give me a moment.');
    return;
  }

  const cfg = loadConfig();
  if (!cfg.farm || !cfg.chest) {
    bot.chat('No farm or chest set. Use !nilo setfarm and !nilo setchest first.');
    return;
  }

  isFarming = true;
  bot.chat('Heading to the farm.');
  console.log('[NILO] Starting farm run.');

  try {
    const { farm, chest } = cfg;
    const mcData = require('minecraft-data')(bot.version);
    const movements = createMovements(bot);
    bot.pathfinder.setMovements(movements);

    // Walk to the farm area centre
    const cx = Math.floor((farm.x1 + farm.x2) / 2);
    const cy = Math.min(farm.y1, farm.y2);
    const cz = Math.floor((farm.z1 + farm.z2) / 2);
    await bot.pathfinder.goto(new GoalBlock(cx, cy, cz));

    // Scan for mature crops inside the bounding box
    const minX = Math.min(farm.x1, farm.x2);
    const maxX = Math.max(farm.x1, farm.x2);
    const minY = Math.min(farm.y1, farm.y2);
    const maxY = Math.max(farm.y1, farm.y2);
    const minZ = Math.min(farm.z1, farm.z2);
    const maxZ = Math.max(farm.z1, farm.z2);

    const matureBlocks = [];
    for (const [cropName, { age }] of Object.entries(MATURE_CROPS)) {
      const blockType = mcData.blocksByName[cropName];
      if (!blockType) continue;

      const found = bot.findBlocks({
        matching: (block) => block.name === cropName && block.getProperties().age === age,
        maxDistance: 128,
        count: 256,
      }).filter(pos =>
        pos.x >= minX && pos.x <= maxX &&
        pos.y >= minY && pos.y <= maxY &&
        pos.z >= minZ && pos.z <= maxZ
      );

      matureBlocks.push(...found);
    }

    if (matureBlocks.length === 0) {
      bot.chat('Nothing is ready to harvest yet.');
      isFarming = false;
      return;
    }

    console.log(`[NILO] Found ${matureBlocks.length} mature crop(s).`);

    // Harvest each block
    for (const pos of matureBlocks) {
      const block = bot.blockAt(pos);
      if (!block) continue;
      await bot.collectBlock.collect(block);
    }

    // Walk to chest and deposit
    bot.chat('Harvest done. Taking it to the chest.');
    await bot.pathfinder.goto(new GoalBlock(chest.x, chest.y, chest.z));

    const chestBlock = bot.blockAt(bot.entity.position.offset(0, 0, 0));
    // Find the chest block near the target coords
    const targetBlock = bot.blockAt({ x: chest.x, y: chest.y, z: chest.z });
    if (targetBlock && targetBlock.name.includes('chest')) {
      const chestContainer = await bot.openContainer(targetBlock);
      // Deposit all harvest items
      const harvestItems = ['wheat', 'carrot', 'potato', 'beetroot'];
      for (const item of bot.inventory.items()) {
        if (harvestItems.includes(item.name)) {
          await chestContainer.deposit(item.type, null, item.count);
        }
      }
      chestContainer.close();
    }

    bot.chat('All done. Farm run complete.');
    console.log('[NILO] Farm run complete.');
  } catch (err) {
    console.error('[NILO] Farm error:', err.message);
    bot.chat('Something went wrong during the farm run.');
  }

  isFarming = false;
}

// ── Proximity & health monitor ────────────────────────────────────────────────

function startProximityMonitor(bot) {
  if (proximityInterval) clearInterval(proximityInterval);

  let wasInRange = false;
  let lowHealthWarned = false;
  let lastGreetTime = 0;
  let lastFollowComplaintTime = 0;
  let lastThreatWarnTime = 0;
  let knownThreats = new Set(); // entity IDs seen this threat cycle
  const RANGE = 15;
  const LOW_HEALTH = 8; // out of 20
  const THREAT_RANGE = 16;
  const GREET_COOLDOWN_MS = 120000;        // 2 min between greets
  const FOLLOW_COMPLAINT_COOLDOWN_MS = 90000; // 90s between follow complaints
  const THREAT_WARN_COOLDOWN_MS = 20000;   // 20s between threat warnings
  const STARTUP_GRACE_MS = 30000;          // suppress all proactive events for 30s after join
  const startTime = Date.now();

  proximityInterval = setInterval(async () => {
    const player = bot.players[MASTER];
    const entity = player?.entity;

    // ── Health check ──────────────────────────────────────────────────────
    if (bot.health <= LOW_HEALTH && !lowHealthWarned && Date.now() - startTime > STARTUP_GRACE_MS) {
      lowHealthWarned = true;
      try {
        const response = await queryLetta(
          `${sessionHintFor(MASTER)}[HEALTH EVENT] Your current health is ${bot.health}/20. React briefly in character — you feel unwell.\n[Respond in: en]`
        );
        const { text: healthText } = parseAction(response);
        if (healthText) bot.chat(healthText);
      } catch (_) {}
    }
    if (bot.health > LOW_HEALTH) lowHealthWarned = false;

    // ── Threat scan ───────────────────────────────────────────────────────
    if (behaviorMode === 'follow' || behaviorMode === 'idle' || behaviorMode === 'wander') {
      const now2 = Date.now();
      if (now2 - startTime > STARTUP_GRACE_MS) {
        const nearbyHostiles = Object.values(bot.entities).filter(e =>
          isHostileMob(e) && e.position.distanceTo(bot.entity.position) < THREAT_RANGE
        );
        const newThreats = nearbyHostiles.filter(e => !knownThreats.has(e.id));
        if (newThreats.length > 0 && now2 - lastThreatWarnTime >= THREAT_WARN_COOLDOWN_MS) {
          lastThreatWarnTime = now2;
          const names = [...new Set(newThreats.map(e => e.name))].join(', ');
          queryLetta(
            `${sessionHintFor(MASTER)}[THREAT EVENT] You just spotted hostile mob(s) nearby: ${names}. React briefly — a quick warning or tense observation.\n[Respond in: en]`
          ).then(r => { const { text: t } = parseAction(r); if (t) bot.chat(t); }).catch(() => {});
        }
        knownThreats = new Set(nearbyHostiles.map(e => e.id));
      }
    }

    // ── Proximity check ───────────────────────────────────────────────────
    if (!entity) {
      wasInRange = false;
      return;
    }

    const dist = entity.position.distanceTo(bot.entity.position);
    const inRange = dist <= RANGE;
    const now = Date.now();

    if (inRange && !wasInRange) {
      wasInRange = true;
      // Only greet if startup grace has passed and enough time since last greet
      if (now - startTime > STARTUP_GRACE_MS && now - lastGreetTime >= GREET_COOLDOWN_MS) {
        lastGreetTime = now;
        try {
          const response = await queryLetta(
            `${sessionHintFor(MASTER)}[PROXIMITY EVENT] PrizmoElectric just came within ${Math.floor(dist)} blocks of you. Greet them briefly in character.\n[Respond in: en]`
          );
          const { text: greetText } = parseAction(response);
          if (greetText) bot.chat(greetText);
        } catch (_) {}
      }
    }

    if (!inRange && wasInRange) {
      wasInRange = false;
      // Only complain about follow if not catching up (complain once per cooldown)
      if (behaviorMode === 'follow' && now - lastFollowComplaintTime >= FOLLOW_COMPLAINT_COOLDOWN_MS) {
        lastFollowComplaintTime = now;
        try {
          const response = await queryLetta(
            `${sessionHintFor(MASTER)}[PROXIMITY EVENT] PrizmoElectric moved far away and you're having trouble keeping up while following them. Say something brief in character.\n[Respond in: en]`
          );
          const { text: followText } = parseAction(response);
          if (followText) bot.chat(followText);
        } catch (_) {}
      }
    }
  }, 2000);
}

// ── Item helpers ──────────────────────────────────────────────────────────────

function getEquipDestination(item) {
  const n = item.name;
  // Head — vanilla + common modded keywords
  if (['helmet','cap','skull','hat','hood','mask','helm','crown','circlet',
       'coif','casque','bascinet','barbute','morion','headband','headgear',
       'goggles','tiara','crest'].some(k => n.includes(k))) return 'head';
  // Torso
  if (['chestplate','tunic','elytra','breastplate','vest','jacket','hauberk',
       'chestguard','cuirass','coat','brigandine','jerkin','surcoat',
       'chest_armor','body_armor'].some(k => n.includes(k))) return 'torso';
  // Legs
  if (['leggings','pants','trousers','greaves','cuisses','chausses',
       'legguard','leg_armor','kilt','skirt'].some(k => n.includes(k))) return 'legs';
  // Feet
  if (['boots','shoes','sabatons','sollerets','sandals','slippers',
       'greave'].some(k => n.includes(k))) return 'feet';
  // Off-hand
  if (n.includes('shield') || n.includes('buckler') || n.includes('offhand')) return 'off-hand';
  return 'hand';
}

function isWeapon(item) {
  // Broad weapon check — covers vanilla and common modded weapons
  return ['sword','axe','mace','trident','scythe','dagger','spear','glaive',
    'halberd','rapier','hammer','club','saber','claymore','katana','tachi',
    'blade','staff','wand','scepter','tome','spellbook','casting',
    'bow','crossbow','gun','rifle','pistol','musket','flintlock',
    'whip','flail','maul','quarterstaff','lance'].some(k => item.name.includes(k));
}

function isEquippable(item) {
  if (isWeapon(item)) return true;
  return getEquipDestination(item) !== 'hand'; // armor / shield / off-hand items
}

// Walk to nearest dropped item within maxDist, wait for pickup
async function pickupNearestItem(bot, maxDist = 8) {
  const { goals: { GoalNear } } = require('mineflayer-pathfinder');
  const dropped = Object.values(bot.entities).filter(e =>
    e.name === 'item' && e.position.distanceTo(bot.entity.position) < maxDist
  ).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));

  if (dropped.length === 0) return false;
  const item = dropped[0];
  const movements = createMovements(bot);
  bot.pathfinder.setMovements(movements);
  await bot.pathfinder.goto(new GoalNear(item.position.x, item.position.y, item.position.z, 1));
  await new Promise(r => setTimeout(r, 600)); // let inventory update
  return true;
}

// ── Autonomous behaviors ──────────────────────────────────────────────────────

function startAutonomousBehaviors(bot) {
  if (autonomousInterval) clearInterval(autonomousInterval);

  let lookCooldown = 0;   // ticks until next look is allowed
  let exploreCooldown = 0; // ticks until next explore step

  autonomousInterval = setInterval(async () => {
    // ── Natural look ─────────────────────────────────────────────────────────
    if (lookCooldown > 0) {
      lookCooldown--;
    } else {
      // Prioritise players, fall back to mobs
      const target = bot.nearestEntity(e => {
        if (e === bot.entity) return false;
        const dist = e.position.distanceTo(bot.entity.position);
        return dist < 10 && dist > 0.5 && (e.type === 'player' || e.type === 'mob');
      });
      if (target && Math.random() > 0.4) {
        // look at head level
        const headOffset = target.height != null ? target.height : 1.6;
        bot.lookAt(target.position.offset(0, headOffset, 0), false).catch(() => {});
        // hold gaze for 3–8 ticks (6–16 s), then allow next look
        lookCooldown = 3 + Math.floor(Math.random() * 5);
      }
    }

    // ── Exploration ───────────────────────────────────────────────────────────
    if (!exploringEnabled || isFarming || isLooting || behaviorMode !== 'idle') return;

    if (exploreCooldown > 0) { exploreCooldown--; return; }
    exploreCooldown = 4 + Math.floor(Math.random() * 4); // 8–16 s between steps

    // Check for nearby chests first
    const chestBlock = bot.findBlock({
      matching: b => b.name === 'chest' || b.name === 'trapped_chest',
      maxDistance: 24,
    });

    if (chestBlock) {
      isLooting = true;
      try {
        const { goals: { GoalNear } } = require('mineflayer-pathfinder');
        const movements = createMovements(bot);
        bot.pathfinder.setMovements(movements);
        const p = chestBlock.position;
        await bot.pathfinder.goto(new GoalNear(p.x, p.y, p.z, 2));
        const container = await bot.openContainer(chestBlock);
        const items = container.containerItems();
        container.close();

        const preview = items.length
          ? items.slice(0, 6).map(i => `${i.count}x ${i.name}`).join(', ')
          : 'nothing';
        const response = await queryLetta(
          `[AUTONOMOUS] While exploring you found and opened a chest at (${p.x},${p.y},${p.z}). ` +
          `Contents: ${preview}. React briefly in character — curiosity, excitement, or disappointment.\n[Respond in: en]`
        );
        const { text: chestText } = parseAction(response);
        if (chestText) bot.chat(chestText);
      } catch (err) {
        console.error('[NILO] Chest loot error:', err.message);
      }
      isLooting = false;
      return;
    }

    // No chest nearby — wander to a random position
    const pos = bot.entity.position;
    const rx = pos.x + (Math.random() * 40 - 20);
    const rz = pos.z + (Math.random() * 40 - 20);
    const movements = createMovements(bot);
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new GoalBlock(Math.floor(rx), Math.floor(pos.y), Math.floor(rz)));
  }, 2000);
}

// ── Skill autonomy ticker ─────────────────────────────────────────────────────
// Separate interval so it doesn't block the explore loop.

function startSkillAutonomyTicker(bot) {
  setInterval(async () => {
    if (!autonomousSkillsEnabled) return;
    if (skillLearnInProgress) return;
    if (behaviorMode !== 'idle') return;
    if (isFarming || isLooting) return;

    skillLearnInProgress = true;
    try {
      await skillEngine.autonomousTick(bot, lastInteractionTime);
    } catch (err) {
      console.error('[SKILL] Autonomous tick error:', err.message);
    } finally {
      skillLearnInProgress = false;
    }
  }, 60_000); // check every minute; engine enforces 10-min gap internally
}

// ── Language detection ────────────────────────────────────────────────────────

const PT_WORDS = new Set([
  'não','sim','você','voce','obrigado','obrigada','por','favor','aqui','ali',
  'também','tambem','mas','então','entao','quando','onde','como','porque',
  'que','uma','uns','umas','seu','sua','dele','dela','nós','nos','eles','elas',
  'me','te','se','lhe','meu','minha','teu','tua','isso','esse','essa','este',
  'esta','aquele','aquela','está','esta','estou','sou','são','sao','tem','têm',
  'vou','vai','vem','foi','era','fui','pelo','pela','num','numa','com','sem',
  'pra','para','até','ate','sobre','entre','depois','antes','agora','ainda',
  'sempre','nunca','já','ja','muito','pouco','mais','menos','bem','mal',
  'quero','posso','pode','preciso','tenho','conta','diz','faz','vai',
]);

function detectLanguage(text) {
  const words = text.toLowerCase().replace(/[^a-záàâãéèêíóôõúüç\s]/g, '').split(/\s+/);
  const ptCount = words.filter(w => PT_WORDS.has(w)).length;
  return ptCount >= 1 ? 'pt-BR' : 'en';
}

// ── Inventory helpers ─────────────────────────────────────────────────────────

function getInventorySummary(bot) {
  const items = bot.inventory.items();
  if (items.length === 0) return 'empty';
  return items.map(i => `${i.count}x ${i.name}`).join(', ');
}

// ── Grave pickup ──────────────────────────────────────────────────────────────

async function collectGrave(bot) {
  clearBehavior(bot);

  // YIGD block is registered as 'grave' (namespace stripped by mineflayer).
  // Also catch 'gravestone', 'tomb', 'coffin' for other grave mods.
  const GRAVE_NAMES = ['grave', 'gravestone', 'tomb', 'coffin', 'soulstone'];
  const grave = bot.findBlock({
    matching: b => {
      const n = b.name.toLowerCase();
      const match = GRAVE_NAMES.some(k => n.includes(k));
      if (match) console.log(`[NILO] Found grave block: ${b.name} at ${b.position}`);
      return match;
    },
    maxDistance: 128,
  });

  if (!grave) {
    // Log nearby unusual blocks to help diagnose wrong name
    const sample = [];
    bot.findBlock({ matching: b => {
      if (sample.length < 20 && !['air','grass_block','dirt','stone','water','oak_log','oak_leaves','gravel','sand'].includes(b.name)) {
        sample.push(b.name);
      }
      return false;
    }, maxDistance: 20 });
    console.log('[NILO] No grave found. Nearby non-trivial blocks:', [...new Set(sample)].join(', ') || 'none');
    bot.chat("I can't find my grave nearby.");
    return;
  }

  bot.chat(`Found it. Going to ${grave.position.x}, ${grave.position.y}, ${grave.position.z}.`);

  try {
    const movements = createMovements(bot);
    bot.pathfinder.setMovements(movements);
    const p = grave.position;
    await bot.pathfinder.goto(new GoalNear(p.x, p.y, p.z, 2));

    // Try opening as a container (YIGD exposes grave as inventory)
    try {
      const container = await bot.openContainer(grave);
      const items = container.containerItems();
      for (const item of items) {
        try { await container.withdraw(item.type, null, item.count); } catch (_) {}
      }
      container.close();
      bot.chat(`Got my stuff back (${items.length} stacks).`);
      console.log(`[NILO] Collected grave (${items.length} item stacks).`);
      return;
    } catch (containerErr) {
      console.log('[NILO] openContainer failed:', containerErr.message, '— trying sneak+right-click');
    }

    // Fallback: sneak + right-click (some YIGD versions auto-collect on sneak)
    bot.setControlState('sneak', true);
    await bot.lookAt(grave.position.offset(0.5, 0.5, 0.5), true);
    await bot.activateBlock(grave);
    await new Promise(r => setTimeout(r, 800));
    bot.setControlState('sneak', false);
    bot.chat('Tried to collect the grave.');
    console.log('[NILO] Activated grave block (sneak fallback).');
  } catch (err) {
    console.error('[NILO] Grave collect error:', err.message);
    bot.chat("Something went wrong trying to get my grave.");
  }
}

// ── Natural language assistance (PrizmoElectric only) ─────────────────────────
// Returns true if a command was matched and executed, false to fall through.

// Start following a player — uses GoalFollow (pathfinder dynamic goal).
// GoalFollow continuously recalculates as the entity moves, handles all terrain.
// A 1-second refresh interval re-acquires the entity handle and adjusts distance.
function startFollow(bot, targetUsername, distance = 2) {
  setBehavior(bot, 'follow', targetUsername);
  bot.pathfinder.setMovements(createMovements(bot));

  function setFollowGoal() {
    if (behaviorMode !== 'follow') { clearInterval(followInterval); return; }
    const target = bot.players[targetUsername]?.entity;
    if (!target) { bot.clearControlStates(); return; }
    bot.pathfinder.setGoal(new GoalFollow(target, distance), true);
  }

  setFollowGoal(); // set immediately
  const followInterval = setInterval(setFollowGoal, 1000);

  function cleanup() {
    clearInterval(followInterval);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
  }

  behaviorInterval = { _cleanup: cleanup };
}

// ── Hostile mob names ─────────────────────────────────────────────────────────

const HOSTILE_MOBS = new Set([
  'zombie','skeleton','creeper','spider','cave_spider','witch','enderman','slime',
  'blaze','ghast','wither_skeleton','phantom','drowned','husk','stray','pillager',
  'vindicator','ravager','evoker','vex','hoglin','zoglin','piglin_brute',
  'guardian','elder_guardian','shulker','silverfish','endermite','magma_cube',
  'zombie_villager','zombie_pigman','zombified_piglin','warden','breeze',
]);
function isHostileMob(entity) {
  return entity.type === 'mob' && (HOSTILE_MOBS.has(entity.name) || entity.type === 'hostile');
}

// ── Weapon helpers ────────────────────────────────────────────────────────────

function equipBestMeleeWeapon(bot) {
  const priority = [
    'netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword','golden_sword',
    'netherite_axe','diamond_axe','iron_axe','stone_axe','wooden_axe','golden_axe',
  ];
  for (const name of priority) {
    const item = bot.inventory.items().find(i => i.name === name);
    if (item) { bot.equip(item, 'hand').catch(() => {}); return; }
  }
}

function hasBowAndArrows(bot) {
  const bow = bot.inventory.items().find(i => i.name === 'bow' || i.name === 'crossbow');
  const arrows = bot.inventory.items().find(i => i.name.includes('arrow'));
  return bow && arrows ? { bow, arrows } : null;
}

function equipShield(bot) {
  const shield = bot.inventory.items().find(i => i.name === 'shield');
  if (shield) bot.equip(shield, 'off-hand').catch(() => {});
}

// VANILLA_IRON_DOORS — only these two require redstone; all others can be pushed open.
const VANILLA_IRON_DOORS = new Set(['iron_door', 'iron_trapdoor']);

// DOOR_KEYWORDS — block-name substrings that identify openable door-like blocks.
// Covers vanilla + common modded naming patterns (Macaw's, Quark, Farmer's Delight…).
const DOOR_KEYWORDS = ['door', 'trapdoor', 'gate', 'hatch', 'shutter', 'portcullis', 'wicket', 'flap'];

// buildOpenableIds — scans the block registry once after login.
// Returns a Set<number> of block IDs for every door-like block the bot can open.
function buildOpenableIds(bot) {
  const ids = new Set();
  for (const block of Object.values(bot.registry.blocksByName || {})) {
    if (VANILLA_IRON_DOORS.has(block.name)) continue;
    const n = block.name.toLowerCase();
    if (DOOR_KEYWORDS.some(k => n.includes(k))) ids.add(block.id);
  }
  return ids;
}

// Substrings that identify blocks which should NEVER be in the fences set —
// they're full 1×1×1 blocks whose minStateId shape is misleadingly > 1 block
// (e.g. a decorative top, an arm in the default wall state, etc.).
const FENCE_SAFE_PATTERNS = [
  'stone_brick', 'stonebrick', 'cobblestone', 'mossy', 'cracked',
  'polished', 'smooth', 'chiseled', 'cut_', 'deepslate', 'blackstone',
  'basalt', 'granite', 'diorite', 'andesite', 'calcite', 'tuff',
  'sandstone', 'red_sandstone', 'prismarine', 'end_stone',
  'nether_brick', 'quartz', 'purpur', 'terracotta',
];
// These always stay in fences even if the above patterns match.
const FENCE_KEEP_PATTERNS = ['fence', 'wall', 'bar', 'pane', 'grate', 'trellis'];

// createMovements — standard Movements with door/gate/trapdoor opening enabled.
// Pass { canDig: false } to prevent block breaking (e.g. unstuck phase 2).
function createMovements(bot, opts = {}) {
  const movements = new Movements(bot);

  // Let pathfinder PLAN routes that pass through doors (it marks openable blocks
  // as walkable in the cost graph). Actual door-opening is handled by the
  // proactive door opener below — this flag just enables the path planning.
  movements.canOpenDoors = true;

  // Populate openable with all door-like blocks the bot can interact with.
  if (bot._openableIds) {
    for (const id of bot._openableIds) movements.openable.add(id);
  } else {
    for (const block of Object.values(bot.registry.blocksByName || {})) {
      if (VANILLA_IRON_DOORS.has(block.name)) continue;
      const n = block.name.toLowerCase();
      if (DOOR_KEYWORDS.some(k => n.includes(k))) movements.openable.add(block.id);
    }
  }

  // ── Fences set cleanup ────────────────────────────────────────────────────
  // The pathfinder builds `fences` by checking each block's minStateId shape.
  // Modded stone/brick blocks often have decorative tops or wall-post default
  // states that push shapes[0][4] > 1, landing them in `fences` and making
  // them completely impassable. Remove the obvious false-positives.
  let fencesRemoved = 0;
  for (const id of [...movements.fences]) {
    const block = bot.registry.blocks[id];
    if (!block) continue;
    const n = block.name.toLowerCase();
    if (
      FENCE_SAFE_PATTERNS.some(p => n.includes(p)) &&
      !FENCE_KEEP_PATTERNS.some(p => n.includes(p))
    ) {
      movements.fences.delete(id);
      fencesRemoved++;
    }
  }
  if (fencesRemoved > 0) {
    console.log(`[NILO] Removed ${fencesRemoved} stone/brick block(s) from fences set.`);
  }

  if (opts.canDig === false) movements.canDig = false;
  return movements;
}

// ── Proactive door opener ─────────────────────────────────────────────────────
// mineflayer-pathfinder's built-in door-opening is known to misbehave on
// non-Paper (i.e. Fabric) servers. This handler runs every physics tick and
// opens any adjacent closed door BEFORE the pathfinder's executor reaches it,
// so the executor always finds the door already open and just walks through.

function installDoorOpener(bot) {
  const openableIds = bot._openableIds; // built once in login handler
  const lastAttempt = new Map();        // blockPos key → timestamp, prevents spam

  bot.on('physicsTick', () => {
    if (!bot.pathfinder.isMoving()) return;

    const pos = bot.entity.position;
    // Check all adjacent positions at foot and eye level
    const offsets = [
      [1,0,0],[-1,0,0],[0,0,1],[0,0,-1],
      [1,1,0],[-1,1,0],[0,1,1],[0,1,-1],
    ];

    for (const [ox, oy, oz] of offsets) {
      const block = bot.blockAt(pos.offset(ox, oy, oz));
      if (!block || !openableIds.has(block.type)) continue;

      // Only act on CLOSED doors (closed doors have shapes; open ones are empty)
      const props = block.getProperties ? block.getProperties() : {};
      if (props.open === true || props.open === 'true') continue;

      const key = `${block.position.x},${block.position.y},${block.position.z}`;
      const now = Date.now();
      if (now - (lastAttempt.get(key) || 0) < 1200) continue; // 1.2s cooldown per block

      lastAttempt.set(key, now);
      bot.activateBlock(block).catch(() => {});
      break; // open one door per tick max
    }
  });
}

// ── Smart attack (melee) ──────────────────────────────────────────────────────

function startAttack(bot, username) {
  setBehavior(bot, 'attack', username);
  bot.chat('On it.');
  equipShield(bot);
  equipBestMeleeWeapon(bot);
  const movements = createMovements(bot);
  bot.pathfinder.setMovements(movements);
  let lastSwing = 0;
  let shieldUp = false;

  const lowerShield = () => {
    if (shieldUp) { bot.deactivateItem(); shieldUp = false; }
  };
  const raiseShield = () => {
    if (!shieldUp) { bot.activateItem(true); shieldUp = true; } // true = off-hand
  };

  behaviorInterval = setInterval(async () => {
    if (behaviorMode !== 'attack') { lowerShield(); return; }

    // Retreat when critically low on health
    if (bot.health <= 4) {
      lowerShield();
      bot.pathfinder.setGoal(null);
      bot.chat('I need to retreat!');
      setBehavior(bot, 'idle', username);
      return;
    }

    const mob = bot.nearestEntity(e => isHostileMob(e) && e.position.distanceTo(bot.entity.position) < 24);
    if (!mob) { bot.pathfinder.setGoal(null); lowerShield(); return; }

    const dist = mob.position.distanceTo(bot.entity.position);
    try {
      if (dist > 3) {
        lowerShield(); // lower while sprinting — shield slows movement
        bot.pathfinder.setGoal(new GoalNear(mob.position.x, mob.position.y, mob.position.z, 2), true);
      } else {
        bot.pathfinder.setGoal(null);
        raiseShield(); // raise as soon as mob is in melee range
        await bot.lookAt(mob.position.offset(0, mob.height * 0.9, 0), true);
        const now = Date.now();
        if (now - lastSwing >= 500) {
          bot.attack(mob);
          lastSwing = now;
        }
      }
    } catch (err) {
      console.error('[NILO] Attack error:', err.message);
    }
  }, 200);
}

// ── Unstuck ───────────────────────────────────────────────────────────────────

async function tryUnstuck(bot) {
  clearBehavior(bot);
  bot.clearControlStates();

  const startPos = bot.entity.position.clone();

  // Phase 1: raw controls — bypasses pathfinder, works even when wedged in blocks
  const tries = [
    { forward: true, jump: true },
    { back:    true, jump: true },
    { left:    true, jump: true },
    { right:   true, jump: true },
    { forward: true             },
    { back:    true             },
    { left:    true             },
    { right:   true             },
    {                jump: true },
  ];

  for (const controls of tries) {
    bot.clearControlStates();
    for (const [k, v] of Object.entries(controls)) bot.setControlState(k, v);
    await new Promise(r => setTimeout(r, 500));
    bot.clearControlStates();
    if (bot.entity.position.distanceTo(startPos) > 0.5) {
      console.log('[NILO] Unstuck via raw movement.');
      return true;
    }
  }

  // Phase 2: pathfinder without digging — tries nearby positions in all directions
  bot.pathfinder.setMovements(createMovements(bot, { canDig: false }));

  const p = bot.entity.position;
  const candidates = [
    [5,0,0], [-5,0,0], [0,0,5], [0,0,-5],
    [4,1,0], [-4,1,0], [0,1,4], [0,1,-4],
    [3,0,3], [-3,0,-3], [3,0,-3], [-3,0,3],
    [0,2,0],
  ];

  for (const [ox, oy, oz] of candidates) {
    try {
      await bot.pathfinder.goto(new GoalBlock(
        Math.floor(p.x + ox),
        Math.floor(p.y + oy),
        Math.floor(p.z + oz)
      ));
      if (bot.entity.position.distanceTo(startPos) > 1) {
        console.log('[NILO] Unstuck via pathfinder.');
        return true;
      }
    } catch (_) {}
  }

  console.log('[NILO] Unstuck: could not escape.');
  return false;
}

// ── Fishing ───────────────────────────────────────────────────────────────────

async function startFishing(bot) {
  const rod = bot.inventory.items().find(i => i.name.includes('fishing_rod'));
  if (!rod) { bot.chat("I don't have a fishing rod."); return; }

  setBehavior(bot, 'fishing', MASTER);
  bot.chat('Casting the line...');

  try { await bot.equip(rod, 'hand'); } catch (_) {}

  let bobber = null;
  let castTime = 0;

  const onEntitySpawn = (entity) => {
    if (entity.name === 'fishing_bobber' && entity.username === BOT_USERNAME) {
      bobber = entity;
    }
  };
  const onCollect = (collector) => {
    if (collector.username === BOT_USERNAME && behaviorMode === 'fishing') {
      bot.chat('Got something!');
    }
  };
  bot.on('entitySpawn', onEntitySpawn);
  bot.on('playerCollect', onCollect);

  const recast = async () => {
    if (behaviorMode !== 'fishing') {
      bot.removeListener('entitySpawn', onEntitySpawn);
      bot.removeListener('playerCollect', onCollect);
      return;
    }
    try {
      const r = bot.inventory.items().find(i => i.name.includes('fishing_rod'));
      if (!r) { bot.chat('No fishing rod left.'); setBehavior(bot, 'idle', MASTER); return; }
      await bot.equip(r, 'hand');
      bot.activateItem(); // cast / reel
      castTime = Date.now();
      bobber = null;
    } catch (err) {
      console.error('[NILO] Fishing cast error:', err.message);
    }
    // Wait 20-40s then reel in and recast regardless
    const wait = 20000 + Math.random() * 20000;
    setTimeout(async () => {
      if (behaviorMode !== 'fishing') return;
      bot.activateItem(); // reel in
      await new Promise(r => setTimeout(r, 600));
      recast();
    }, wait);
  };

  // Initial cast
  bot.activateItem();
  castTime = Date.now();
  const wait = 20000 + Math.random() * 20000;
  setTimeout(async () => {
    if (behaviorMode !== 'fishing') return;
    bot.activateItem(); // reel in
    await new Promise(r => setTimeout(r, 600));
    recast();
  }, wait);

  // Watch for bobber dipping (entity velocity sudden downward spike)
  behaviorInterval = setInterval(() => {
    if (behaviorMode !== 'fishing') {
      clearInterval(behaviorInterval);
      behaviorInterval = null;
      bot.removeListener('entitySpawn', onEntitySpawn);
      bot.removeListener('playerCollect', onCollect);
      return;
    }
    if (!bobber) return;
    // If bobber velocity dips sharply downward, reel in
    if (bobber.velocity && bobber.velocity.y < -0.2 && Date.now() - castTime > 3000) {
      bot.activateItem(); // reel in
      castTime = Date.now() + 99999; // prevent double-reel
      setTimeout(async () => {
        if (behaviorMode !== 'fishing') return;
        await new Promise(r => setTimeout(r, 600));
        recast();
      }, 500);
    }
  }, 200);
}

// ── Bow combat ────────────────────────────────────────────────────────────────

function startBowMode(bot) {
  const BOW_RANGE = 26;
  const OPTIMAL_DIST = 14;  // preferred engagement distance
  const KITE_DIST = 6;      // back away if mob closer than this
  const CHARGE_MS = 900;    // full draw (~18 ticks)

  setBehavior(bot, 'bow', MASTER);
  bot.chat('Bow ready.');

  const movements = createMovements(bot);
  bot.pathfinder.setMovements(movements);
  let shooting = false;

  behaviorInterval = setInterval(async () => {
    if (behaviorMode !== 'bow') return;
    if (shooting) return;

    const hostile = Object.values(bot.entities).find(e =>
      isHostileMob(e) && e.position.distanceTo(bot.entity.position) < BOW_RANGE
    );

    if (!hostile) {
      bot.pathfinder.setGoal(null);
      return;
    }

    // Fall back to melee if out of ammo
    const ranged = hasBowAndArrows(bot);
    if (!ranged) {
      bot.chat('Out of arrows — going melee.');
      startAttack(bot, MASTER);
      return;
    }

    const dist = hostile.position.distanceTo(bot.entity.position);

    // Kite: mob too close — run away to optimal distance
    if (dist < KITE_DIST) {
      const p = bot.entity.position;
      const m = hostile.position;
      const dx = p.x - m.x; const dz = p.z - m.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      bot.pathfinder.setGoal(
        new GoalNear(p.x + (dx / len) * OPTIMAL_DIST, p.y, p.z + (dz / len) * OPTIMAL_DIST, 2), true
      );
      return;
    }

    // Too far — close in
    if (dist > BOW_RANGE * 0.85) {
      bot.pathfinder.setGoal(
        new GoalNear(hostile.position.x, hostile.position.y, hostile.position.z, OPTIMAL_DIST), true
      );
      return;
    }

    // In range — stop moving and shoot
    shooting = true;
    bot.pathfinder.setGoal(null);
    try {
      await bot.equip(ranged.bow, 'hand');

      const travelTicks = dist / 3;
      const leadX = (hostile.velocity?.x || 0) * travelTicks;
      const leadZ = (hostile.velocity?.z || 0) * travelTicks;
      const gravityLift = 0.025 * travelTicks * travelTicks;

      const aimPos = new Vec3(
        hostile.position.x + leadX,
        hostile.position.y + hostile.height * 0.9 + gravityLift,
        hostile.position.z + leadZ
      );

      await bot.lookAt(aimPos, true);
      bot.activateItem();                                       // draw
      await new Promise(r => setTimeout(r, CHARGE_MS));
      if (behaviorMode !== 'bow') { bot.deactivateItem(); shooting = false; return; }
      bot.deactivateItem();                                     // release
      await new Promise(r => setTimeout(r, 400));               // cooldown
    } catch (err) {
      console.error('[NILO] Bow error:', err.message);
    }
    shooting = false;
  }, 300);
}

// ── Quick shelter ─────────────────────────────────────────────────────────────

const BUILDABLE_KEYWORDS = [
  'planks','cobblestone','stone','dirt','log','wood','brick','sand','gravel',
  'deepslate','tuff','andesite','granite','diorite','basalt','blackstone','mud',
];
function isBuildable(item) {
  return BUILDABLE_KEYWORDS.some(k => item.name.includes(k));
}

async function tryPlaceBlock(bot, x, y, z) {
  const target = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
  const cur = bot.blockAt(target);
  if (cur && cur.name !== 'air' && cur.name !== 'cave_air') return true; // already there

  const faces = [
    { offset: new Vec3(0,-1,0), face: new Vec3(0,1,0) },
    { offset: new Vec3(0,1,0),  face: new Vec3(0,-1,0) },
    { offset: new Vec3(1,0,0),  face: new Vec3(-1,0,0) },
    { offset: new Vec3(-1,0,0), face: new Vec3(1,0,0) },
    { offset: new Vec3(0,0,1),  face: new Vec3(0,0,-1) },
    { offset: new Vec3(0,0,-1), face: new Vec3(0,0,1) },
  ];
  for (const { offset, face } of faces) {
    const refPos = target.plus(offset);
    const ref = bot.blockAt(refPos);
    if (!ref || ref.name === 'air' || ref.name === 'cave_air') continue;
    try {
      const movements = createMovements(bot);
      bot.pathfinder.setMovements(movements);
      await bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, 3));
      await bot.lookAt(target, true);
      await bot.placeBlock(ref, face);
      return true;
    } catch (_) {}
  }
  return false;
}

async function buildSimpleHouse(bot) {
  const material = bot.inventory.items().find(isBuildable);
  if (!material) { bot.chat("I don't have any building materials."); return; }

  setBehavior(bot, 'building', MASTER);
  bot.chat('Building a quick shelter...');

  const o = bot.entity.position.floored();

  // Build order: floor first, then walls bottom-up, then roof
  const positions = [];

  // Floor (Y-1)
  for (let x = -2; x <= 2; x++)
    for (let z = -2; z <= 2; z++)
      positions.push({ x: o.x+x, y: o.y-1, z: o.z+z });

  // Walls — perimeter, 3 high; leave a 1×2 entrance on south (z=+2, x=0)
  for (let h = 0; h <= 2; h++) {
    for (let i = -2; i <= 2; i++) {
      // North wall
      positions.push({ x: o.x+i, y: o.y+h, z: o.z-2 });
      // South wall — skip entrance gap (x=0, h=0/1)
      if (!(i === 0 && h <= 1)) positions.push({ x: o.x+i, y: o.y+h, z: o.z+2 });
      // East/West (no corners, already in N/S)
      if (i > -2 && i < 2) {
        positions.push({ x: o.x-2, y: o.y+h, z: o.z+i });
        positions.push({ x: o.x+2, y: o.y+h, z: o.z+i });
      }
    }
  }

  // Roof (Y+3)
  for (let x = -2; x <= 2; x++)
    for (let z = -2; z <= 2; z++)
      positions.push({ x: o.x+x, y: o.y+3, z: o.z+z });

  let placed = 0;
  for (const pos of positions) {
    if (behaviorMode !== 'building') break;
    const mat = bot.inventory.items().find(isBuildable);
    if (!mat) { bot.chat('Ran out of building materials.'); break; }
    try {
      await bot.equip(mat, 'hand');
      const ok = await tryPlaceBlock(bot, pos.x, pos.y, pos.z);
      if (ok) placed++;
    } catch (err) {
      console.error('[NILO] Build error:', err.message);
    }
  }

  if (behaviorMode === 'building') {
    setBehavior(bot, 'idle', MASTER);
    bot.chat(`Done! Placed ${placed} blocks.`);
  }
}

// ── Dance ─────────────────────────────────────────────────────────────────────

function startDance(bot) {
  setBehavior(bot, 'dance', MASTER);
  bot.chat('*starts dancing*');

  // Each move: [controlStates to set, duration ms]
  // Phases cycle: spin → jump-spin → strafe bounce → spin → repeat
  let phase = 0;
  let tick = 0;

  // Clear movement before starting
  bot.clearControlStates();

  behaviorInterval = setInterval(() => {
    if (behaviorMode !== 'dance') return;

    tick++;
    const t = tick % 40; // 40-tick (~2s) cycle at 50ms interval

    // Arm swing on every other tick for flair
    if (tick % 4 === 0) bot.swingArm();

    if (t < 10) {
      // Phase 1: spin left + jump
      bot.clearControlStates();
      bot.setControlState('jump', t % 2 === 0);
      const spinYaw = (bot.entity.yaw + 0.35) % (Math.PI * 2);
      bot.look(spinYaw, 0.2, false);
    } else if (t < 20) {
      // Phase 2: strafe right + sneak bounce
      bot.clearControlStates();
      bot.setControlState('right', true);
      bot.setControlState('sneak', t % 4 < 2);
      bot.setControlState('jump', t % 4 >= 2);
    } else if (t < 30) {
      // Phase 3: spin right + squat
      bot.clearControlStates();
      bot.setControlState('jump', t % 3 === 0);
      const spinYaw = (bot.entity.yaw - 0.35 + Math.PI * 2) % (Math.PI * 2);
      bot.look(spinYaw, -0.1, false);
    } else {
      // Phase 4: strafe left + jump
      bot.clearControlStates();
      bot.setControlState('left', true);
      bot.setControlState('jump', t % 3 === 0);
    }
  }, 50);
}

// ── Sleep in bed ──────────────────────────────────────────────────────────────

async function sleepInBed(bot) {
  const bed = bot.findBlock({
    matching: b => b.name.endsWith('_bed'),
    maxDistance: 32,
  });
  if (!bed) { bot.chat("I don't see a bed nearby."); return; }

  const movements = createMovements(bot);
  bot.pathfinder.setMovements(movements);
  try {
    await bot.pathfinder.goto(new GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
    await bot.sleep(bed);
    bot.chat('Goodnight...');
  } catch (err) {
    bot.chat("Can't sleep right now.");
    console.error('[NILO] Sleep error:', err.message);
  }
}

function cmd(patterns) {
  return lower => patterns.some(p => p.test(lower));
}

const IS_FOLLOW = cmd([
  /\bfollow\b/,
  /\bme segue\b/, /\bvem comigo\b/, /\bme acompanha\b/, /\bfica comigo\b/,
]);
const IS_HELP = cmd([
  /\bhelp\b/, /\bassist\b/, /\bprotect me\b/, /\bwatch my back\b/, /\bi need help\b/,
  /\bme ajuda\b/, /\bme ajude\b/, /\bme protege\b/, /\bpreciso de ajuda\b/, /\bme cobre\b/,
]);
const IS_COME = cmd([
  /\bcome here\b/, /\bcome closer\b/, /\bget over here\b/, /\bcome to me\b/, /\bget here\b/,
  /\bvem aqui\b/, /\bvem c[aá]\b/, /\bchega aqui\b/, /\bvem at[eé] mim\b/,
  /\bchega mais\b/, /\bvem mais perto\b/, /\baproxima\b/,
]);
const IS_CLOSER = cmd([
  /\bcloser\b/, /\bkeep closer\b/, /\bstay closer\b/, /\bstick closer\b/, /\bget closer\b/,
  /\bfique mais perto\b/, /\bfica mais perto\b/, /\bmais perto\b/,
]);
const IS_UNSTUCK = cmd([
  /\bunstuck\b/, /\bmove away\b/, /\bget out of the way\b/, /\bget unstuck\b/,
  /\bdestravar\b/, /\bsai do caminho\b/, /\bse mexe\b/, /\bmove-te\b/,
]);
const IS_STOP = cmd([
  /\b(go away|leave me|get away|stop following|shoo|back off|give me space)\b/,
  /\b(vai embora|me deixa|sai daqui|vai fora|sai fora|para de me seguir)\b/,
]);
const IS_STAY = cmd([
  /\bstay\b/, /\bstop\b/, /\bwait\b/, /\bhold on\b/, /\bdon'?t move\b/,
  /\bfica aqui\b/, /\bpara\b/, /\bespera\b/, /\bn[aã]o se mexa\b/, /\baguarda\b/,
]);
const IS_SIT = cmd([/\bsit\b/, /\bsenta\b/]);
const IS_WANDER = cmd([/\bwander\b/, /\bvagabundeia\b/]);
const IS_ATTACK = cmd([/\battack\b/, /\bataca\b/]);
const IS_DEFENSIVE = cmd([/\bdefensive\b/, /\bdefensivo\b/]);
const IS_PASSIVE = cmd([/\bpassive\b/, /\bpassivo\b/]);
const IS_STOP_EXPLORE = cmd([
  /\bstop exploring\b/, /\bdon'?t explore\b/, /\bstop wandering\b/, /\bdon'?t wander\b/,
  /\bpara de explorar\b/, /\bn[aã]o explora\b/, /\bfica parado\b/,
]);
const IS_EXPLORE = cmd([
  /\bgo explore\b/, /\bstart exploring\b/, /\bgo wander\b/, /\bexplore\b/,
  /\bvai explorar\b/, /\bcome[cç]a a explorar\b/, /\bexplora\b/,
]);
const IS_FISH = cmd([
  /\bfish\b/, /\bgo fish(ing)?\b/, /\bstart fish(ing)?\b/, /\bcast (the )?line\b/,
  /\bpesca\b/, /\bvai pescar\b/, /\bcome[cç]a a pescar\b/,
]);
const IS_STOP_FISH = cmd([
  /\bstop fish(ing)?\b/, /\bstop casting\b/, /\bpara de pescar\b/,
]);
const IS_BOW = cmd([
  /\buse (the |your )?bow\b/, /\bshoot (with )?bow\b/, /\bsnipe\b/, /\bbow (mode|attack|combat)\b/, /\branged (mode|attack|combat)\b/,
  /\busa (o )?arco\b/, /\batira com arco\b/, /\bcombate (a )?dist[aâ]ncia\b/, /\barco e flecha\b/,
]);
const IS_BUILD = cmd([
  /\bbuild (a |me a )?(quick |small |simple )?(house|shelter|hut|base)\b/,
  /\bconstro[ií] (uma )?(casa|cabana|abrigo|base)\b/,
  /\bconstruir (uma )?(casa|cabana|abrigo|base)\b/,
]);
const IS_SLEEP = cmd([
  /\bsleep\b/, /\bgo to sleep\b/, /\bsleep in (that|the|this) bed\b/, /\buse (the |that |this )?bed\b/,
  /\bdormir?\b/, /\bdeita\b/, /\bdorme na cama\b/, /\busa a cama\b/,
]);
const IS_DANCE = cmd([
  /\bdance\b/, /\bstart danc(ing)?\b/, /\bdo (a )?dance\b/, /\bshow (me )?your (moves|dance)\b/,
  /\bdanc[ae]\b/, /\bdan[cç]ar\b/, /\bmostra (seus )?passos\b/,
]);

async function handleNaturalCommand(bot, lower, raw) {

  if (IS_FOLLOW(lower)) {
    bot.setControlState('sneak', false); // unsit if sitting
    startFollow(bot, MASTER, 2);
    bot.chat('On my way.');
    return true;
  }

  if (IS_HELP(lower)) {
    setBehavior(bot, 'defensive', MASTER);
    startFollow(bot, MASTER, 3);
    bot.chat('Sticking close. I will fight back if needed.');
    return true;
  }

  if (IS_COME(lower)) {
    setBehavior(bot, 'idle', MASTER);
    const target = bot.players[MASTER]?.entity;
    if (target) {
      const movements = createMovements(bot);
      bot.pathfinder.setMovements(movements);
      const pos = target.position;
      bot.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, 2));
    }
    bot.chat('Coming.');
    return true;
  }

  if (IS_CLOSER(lower)) {
    // Tighten follow distance to 1 block
    startFollow(bot, MASTER, 1);
    bot.chat('Got it, staying right with you.');
    return true;
  }

  if (IS_UNSTUCK(lower)) {
    bot.chat('Trying to get free...');
    tryUnstuck(bot)
      .then(ok => { if (!ok) bot.chat("Completely stuck. Can you give me a hand?"); })
      .catch(err => console.error('[NILO] Unstuck error:', err.message));
    return true;
  }

  if (IS_STOP(lower)) {
    setBehavior(bot, 'idle', MASTER);
    bot.chat('Backing off.');
    return true;
  }

  if (IS_SIT(lower)) {
    setBehavior(bot, 'sit', MASTER);
    bot.setControlState('sneak', true);
    bot.chat('Sitting.');
    return true;
  }

  if (IS_STAY(lower)) {
    setBehavior(bot, 'idle', MASTER);
    bot.chat('Staying here.');
    return true;
  }

  if (IS_WANDER(lower)) {
    setBehavior(bot, 'wander', MASTER);
    bot.chat('Going for a wander.');
    const movements = createMovements(bot);
    bot.pathfinder.setMovements(movements);
    behaviorInterval = setInterval(() => {
      if (behaviorMode !== 'wander') return;
      const pos = bot.entity.position;
      const rx = pos.x + (Math.random() * 20 - 10);
      const rz = pos.z + (Math.random() * 20 - 10);
      bot.pathfinder.setGoal(new GoalBlock(Math.floor(rx), Math.floor(pos.y), Math.floor(rz)));
    }, 5000);
    return true;
  }

  if (IS_ATTACK(lower)) {
    startAttack(bot, MASTER);
    return true;
  }

  if (IS_DEFENSIVE(lower)) {
    setBehavior(bot, 'defensive', MASTER);
    bot.chat('Defensive mode. I will only fight back.');
    return true;
  }

  if (IS_PASSIVE(lower)) {
    setBehavior(bot, 'passive', MASTER);
    bot.chat('Passive mode. I will not fight.');
    return true;
  }

  if (IS_STOP_EXPLORE(lower)) {
    exploringEnabled = false;
    setBehavior(bot, 'idle', MASTER);
    bot.chat('Stopping exploration.');
    return true;
  }

  if (IS_EXPLORE(lower)) {
    exploringEnabled = true;
    setBehavior(bot, 'idle', MASTER);
    bot.chat('Going exploring.');
    return true;
  }

  if (IS_STOP_FISH(lower)) {
    if (behaviorMode === 'fishing') {
      setBehavior(bot, 'idle', MASTER);
      bot.deactivateItem();
      bot.chat('Reeling in.');
    }
    return true;
  }

  if (IS_FISH(lower)) {
    startFishing(bot);
    return true;
  }

  if (IS_BOW(lower)) {
    startBowMode(bot);
    return true;
  }

  if (IS_BUILD(lower)) {
    buildSimpleHouse(bot);
    return true;
  }

  if (IS_SLEEP(lower)) {
    sleepInBed(bot);
    return true;
  }

  if (IS_DANCE(lower)) {
    startDance(bot);
    return true;
  }

  // Click/activate block at coordinates — "click button at 100 64 200" / "aperta o botão em 100 64 200"
  {
    const m = lower.match(/(?:click|press|push|activate|use|aperta|clica|ativa|usa)\b.*?(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
    if (m) {
      const [bx, by, bz] = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
      const block = bot.blockAt(new Vec3(bx, by, bz));
      if (!block || block.name === 'air') {
        bot.chat(`Nothing at ${bx} ${by} ${bz}.`);
      } else {
        const movements = createMovements(bot);
        bot.pathfinder.setMovements(movements);
        try {
          await bot.pathfinder.goto(new GoalNear(bx, by, bz, 3));
          await bot.lookAt(new Vec3(bx + 0.5, by + 0.5, bz + 0.5), true);
          await bot.activateBlock(block);
          bot.chat(`Done.`);
        } catch (err) {
          bot.chat(`Couldn't reach that.`);
          console.error('[NILO] ActivateBlock error:', err.message);
        }
      }
      return true;
    }
  }

  // Look at me
  if (/\b(look at me|look here|olha pra mim|me olha|olha aqui|olha pra c[aá])\b/.test(lower)) {
    const target = bot.players[MASTER]?.entity;
    if (target) await bot.lookAt(target.position.offset(0, target.height, 0));
    return true;
  }

  // Eat this
  if (/\b(eat (this|that|it)|come (isso|esse|essa|aqui|ele|ela))\b/.test(lower)) {
    await pickupNearestItem(bot, 8);
    const food = bot.inventory.items().find(i => bot.registry.foodsByName[i.name]);
    if (!food) { bot.chat("I don't have anything to eat."); return true; }
    try { await bot.equip(food, 'hand'); await bot.consume(); bot.chat(`Ate ${food.name}.`); }
    catch (_) { bot.chat("Couldn't eat that."); }
    return true;
  }

  // Equip this/that
  if (/\b(equip this|equip that|equipa isso|equipa ess[ae]|veste ess[ae]|equipa aqui)\b/.test(lower)) {
    await pickupNearestItem(bot, 8);
    const item = bot.inventory.items().find(isEquippable);
    if (!item) { bot.chat("Nothing equippable on me."); return true; }
    const dest = getEquipDestination(item);
    try {
      await bot.equip(item, dest);
      bot.chat(`Equipped ${item.name}.`);
      if (dest === 'hand' && (behaviorMode === 'attack' || behaviorMode === 'defensive')) equipShield(bot);
    } catch (_) { bot.chat("Couldn't equip that."); }
    return true;
  }

  // Equip named item — "equip iron_sword", "equip my bow", "equip apprentice wand"
  {
    const SKIP = ['this','that','isso','esse','essa','aqui','it'];
    const m = lower.match(/\b(?:equip|hold|wield|equipar?|segura(?:r)?|p[õo]e na m[ãa]o|coloca na m[ãa]o)\b\s+(?:(?:my|the|your|a|an|o|a|um|uma)\s+)?["']?([a-z0-9_][a-z0-9_ ]*?)["']?\s*$/);
    if (m && !SKIP.includes(m[1].trim())) {
      const query = m[1].trim().replace(/\s+/g, '_');
      // Try exact substring first, then word-by-word fallback
      const inv = bot.inventory.items();
      const item = inv.find(i => i.name.includes(query))
        ?? inv.find(i => query.split('_').every(w => i.name.includes(w)));
      if (!item) { bot.chat(`I don't have a ${query}.`); return true; }
      const dest = getEquipDestination(item);
      try {
        await bot.equip(item, dest);
        bot.chat(`Equipped ${item.name}.`);
        // In sword+shield mode: ensure shield stays in off-hand after weapon swap
        if (dest === 'hand' && (behaviorMode === 'attack' || behaviorMode === 'defensive')) equipShield(bot);
        // In bow mode: if we just put a bow in hand, re-arm the interval is already running; just confirm
      } catch (_) { bot.chat(`Couldn't equip ${item.name}.`); }
      return true;
    }
  }

  // Unequip and give
  if (/\b(unequip and give me|unequip.*give me|tira e me (da|dá)|tira.*me (da|dá))\b/.test(lower)) {
    const held = bot.heldItem;
    if (!held) { bot.chat("Nothing in my hand."); return true; }
    try {
      const target = bot.players[MASTER]?.entity;
      if (target) {
        const movements = createMovements(bot);
        bot.pathfinder.setMovements(movements);
        await bot.pathfinder.goto(new GoalNear(target.position.x, target.position.y, target.position.z, 2));
      }
      await bot.unequip('hand');
      await bot.tossStack(held);
      bot.chat(`Here, ${held.name}.`);
    } catch (_) { bot.chat("Couldn't hand that over."); }
    return true;
  }

  // Unequip
  if (/\b(unequip that|unequip this|tira isso|tira ess[ae]|desequipa isso)\b/.test(lower)) {
    const held = bot.heldItem;
    if (!held) { bot.chat("Nothing in my hand."); return true; }
    try { await bot.unequip('hand'); bot.chat(`Unequipped ${held.name}.`); }
    catch (_) { bot.chat("Couldn't unequip that."); }
    return true;
  }

  // Grave pickup
  if (/\b(collect (you[r']?|my) grave|get (you[r']?|my) grave|pick( up)? (you[r']?|my) grave(stone)?|go get (you[r']?|my) grave|grab (you[r']?|my) grave|get (you[r']?|my) stuff|grab (you[r']?|my) stuff|go get (you[r']?|my) stuff|pega seu t[uú]mulo|pega sua cova|recupera seus itens|vai pegar seu t[uú]mulo)\b/.test(lower)) {
    bot.chat('Going to get my grave.');
    collectGrave(bot);
    return true;
  }

  // Drop all items
  if (/\b(drop all|drop everything|drop all (your |the )?items?|esvazia (seu |o )?invent[aá]rio|joga tudo fora|larga tudo)\b/.test(lower)) {
    const items = bot.inventory.items();
    if (items.length === 0) { bot.chat("My inventory is empty."); return true; }
    for (const item of items) {
      try { await bot.tossStack(item); } catch (_) {}
    }
    bot.chat('Dropped everything.');
    return true;
  }

  // Drop held item
  if (/\b(drop (the item |it )?in (your|my) hand|drop that|drop what you('re| are) holding|larga o que est[aá] segurando|joga isso fora)\b/.test(lower)) {
    const held = bot.heldItem;
    if (!held) { bot.chat("Nothing in my hand."); return true; }
    try { await bot.tossStack(held); bot.chat(`Dropped ${held.name}.`); }
    catch (_) { bot.chat("Couldn't drop that."); }
    return true;
  }

  // Drop / give item
  const dropMatch = raw.match(/\b(?:drop|give|toss|throw)(?:\s+me)?\s+(?:your\s+|the\s+|some\s+|a\s+|an\s+)?(\w+)/i)
    || raw.match(/\b(?:me\s+(?:dá|da|passa|joga|manda|larga)|larga\s+(?:o|a|os|as|um|uma)?\s*)(\w+)/i);
  if (dropMatch) {
    const itemName = dropMatch[1].toLowerCase();
    const item = bot.inventory.items().find(i => i.name.toLowerCase().includes(itemName));
    if (!item) { bot.chat(`I don't have any ${itemName}.`); return true; }
    try { await bot.tossStack(item); bot.chat(`Dropped ${item.count}x ${item.name}.`); }
    catch (err) { console.error(`[NILO] Drop failed for ${item.name}:`, err.message); bot.chat("Couldn't drop that."); }
    return true;
  }

  // Say / repeat — allow optional trigger word prefix ("nilo say X", "say X", "repeat after me X")
  const repeatMatch = raw.match(/^(?:nilo[,:]?\s+)?(?:repeat after me[:\s]+|say[:\s]+|fala[:\s]+|repete[:\s]+)"?(.+?)"?\s*$/i);
  if (repeatMatch) {
    const toSay = repeatMatch[1].trim();
    if (toSay.startsWith('/')) {
      // Command relay: write chat_command directly (reliable on 1.20.1 offline servers)
      runCommand(bot, toSay);
      bot.chat(`Running: ${toSay.slice(0, 50)}`);
    } else {
      bot.chat(toSay);
    }
    return true;
  }

  return false;
}

// ── Bot ───────────────────────────────────────────────────────────────────────

function createBot() {
  const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: BOT_USERNAME,
    version: MC_VERSION,
    auth: 'offline',
  });

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(collectblock);
  bot.loadPlugin(movementPlugin);

  // minecraft-protocol auto-responds to all login_plugin_request with null,
  // which causes duplicate responses. Remove it so we fully control the handshake.
  bot._client.removeAllListeners('login_plugin_request');

  bot._client.on('login_plugin_request', (packet) => {
    let responseData = null;

    if (packet.channel === 'fabric-networking-api-v1:early_registration' && packet.data) {
      responseData = packet.data;
    } else if (packet.channel === 'forgeconfigapiport:modded_connection') {
      responseData = Buffer.alloc(0);
    }

    bot._client.write('login_plugin_response', {
      messageId: packet.messageId,
      data: responseData,
    });
  });

  const NILO_PASSWORD = 'nilo123';

  bot.on('login', () => {
    console.log(`[NILO] Connected to ${HOST}:${PORT} as ${BOT_USERNAME}`);
    activeBotRef = bot;

    // ── Navigation setup ─────────────────────────────────────────────────────
    // Cache door-like block IDs once so createMovements and the door opener
    // share the same set without re-scanning the registry on every call.
    bot._openableIds = buildOpenableIds(bot);
    console.log(`[NILO] Openable blocks cached: ${bot._openableIds.size}`);

    // Give the pathfinder more time to solve complex modded terrain.
    bot.pathfinder.thinkingTimeout = 5000;

    // Proactive door opener — bypasses the Fabric-broken executor door logic.
    installDoorOpener(bot);

    // ── Path failure recovery ─────────────────────────────────────────────────
    let stuckStreak = 0;         // consecutive stucks in the same vicinity
    let lastStuckPos  = null;

    // path_reset fires when the pathfinder abandons its current path mid-route.
    bot.on('path_reset', (reason) => {
      console.log(`[NILO] path_reset: ${reason}`);
      if (reason !== 'stuck') return;

      const pos = bot.entity.position;
      if (lastStuckPos && pos.distanceTo(lastStuckPos) < 4) {
        stuckStreak++;
      } else {
        stuckStreak = 1;
        lastStuckPos = pos.clone();
      }

      if (stuckStreak >= 3) {
        // Repeated stucks in the same spot — the current path is unworkable.
        // Abandon goal and (for wandering) pick a fresh target far from here.
        console.log('[NILO] Stuck streak: abandoning current path.');
        stuckStreak = 0;
        lastStuckPos = null;
        bot.pathfinder.stop();
        if (behaviorMode === 'idle' || behaviorMode === 'wander') {
          const p = bot.entity.position;
          const rx = p.x + (Math.random() > 0.5 ? 1 : -1) * (15 + Math.random() * 15);
          const rz = p.z + (Math.random() > 0.5 ? 1 : -1) * (15 + Math.random() * 15);
          const mv = createMovements(bot);
          bot.pathfinder.setMovements(mv);
          bot.pathfinder.setGoal(new GoalBlock(Math.floor(rx), Math.floor(p.y), Math.floor(rz)));
        }
      } else {
        tryUnstuck(bot).catch(() => {});
      }
    });

    // path_update fires after each A* computation.
    // When status is 'noPath', the bot has already stopped and won't move again
    // until a new goal is set — in wander/idle mode, immediately pick a new one.
    bot.on('path_update', (r) => {
      if (r.status !== 'noPath') return;
      console.log(`[NILO] No path found (${r.visitedNodes} nodes visited).`);
      stuckStreak = 0;
      lastStuckPos = null;

      if (behaviorMode === 'idle' || behaviorMode === 'wander') {
        const p = bot.entity.position;
        const rx = p.x + (Math.random() * 30 - 15);
        const rz = p.z + (Math.random() * 30 - 15);
        const mv = createMovements(bot);
        bot.pathfinder.setMovements(mv);
        bot.pathfinder.setGoal(new GoalBlock(Math.floor(rx), Math.floor(p.y), Math.floor(rz)));
      }
    });

    startProximityMonitor(bot);
    startAutonomousBehaviors(bot);
    startSkillAutonomyTicker(bot);
    console.log(`[SKILL] Engine ready. ${skillEngine.skillCount()} skill(s) loaded.`);
  });

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString().toLowerCase();
    if (text.includes('register') && text.includes('/register')) {
      bot.chat(`/register ${NILO_PASSWORD} ${NILO_PASSWORD}`);
    } else if (text.includes('login') && text.includes('/login')) {
      bot.chat(`/login ${NILO_PASSWORD}`);
    }
  });

  bot.on('chat', async (username, message) => {
    if (username === BOT_USERNAME) return;

    const lower = message.toLowerCase();
    const mentioned = lower.includes('nilo') || lower.startsWith('!nilo');

    // Disconnect command — MASTER only, no trigger word needed
    if (username === MASTER && /\b(leave( the game)?|disconnect|log off|log out|desconecta|sai do jogo|vai embora do servidor)\b/.test(lower)) {
      bot.chat('Logging off. See you later!');
      setTimeout(() => bot.quit(), 1000);
      return;
    }

    // Natural language assistance for PrizmoElectric — no trigger word needed
    if (username === MASTER) {
      let acted = false;
      try { acted = await handleNaturalCommand(bot, lower, message); }
      catch (err) { console.error('[NILO] handleNaturalCommand error:', err.message); }
      if (acted) { lastInteractionTime = Date.now(); return; }
    }

    // Determine if this message is directed at NILO
    const withinConversationWindow = (Date.now() - lastInteractionTime) < CONVERSATION_WINDOW_MS;
    const playerEntity = bot.players[username]?.entity;
    const withinRange = playerEntity &&
      playerEntity.position.distanceTo(bot.entity.position) <= PROXIMITY_CHAT_RANGE;
    const addressedToNilo = mentioned || (username === MASTER && (withinConversationWindow || withinRange));

    if (!addressedToNilo) return;

    if (mentioned) lastInteractionTime = Date.now();

    // Admin commands (PrizmoElectric only)
    if (username === MASTER) {
      if (lower.match(/^!nilo quit\b/)) {
        bot.chat('Disconnecting...');
        bot.quit();
        return;
      }

      const sayMatch = message.match(/^!nilo say (.+)/i);
      if (sayMatch) { bot.chat(sayMatch[1]); return; }

      const setFarmMatch = message.match(/^!nilo setfarm (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+)/i);
      if (setFarmMatch) {
        const [, x1, y1, z1, x2, y2, z2] = setFarmMatch.map((v, i) => i === 0 ? v : parseInt(v));
        const cfg = loadConfig();
        cfg.farm = { x1, y1, z1, x2, y2, z2 };
        saveConfig(cfg);
        bot.chat(`Farm area set: (${x1},${y1},${z1}) to (${x2},${y2},${z2}).`);
        return;
      }

      const setChestMatch = message.match(/^!nilo setchest (-?\d+) (-?\d+) (-?\d+)/i);
      if (setChestMatch) {
        const [, x, y, z] = setChestMatch.map((v, i) => i === 0 ? v : parseInt(v));
        const cfg = loadConfig();
        cfg.chest = { x, y, z };
        saveConfig(cfg);
        bot.chat(`Chest set at (${x},${y},${z}).`);
        return;
      }

      if (lower.match(/^!nilo farm\b/)) { runFarm(bot); return; }

      // ── Skill engine commands ─────────────────────────────────────────────

      // !nilo learn <task> — generate & store a new skill
      const learnMatch = message.match(/^!nilo learn\s+(.+)/i);
      if (learnMatch) {
        if (skillLearnInProgress) { bot.chat('Already learning something. Give me a moment.'); return; }
        skillLearnInProgress = true;
        skillEngine.learnSkill(bot, learnMatch[1].trim())
          .catch(e => { console.error('[SKILL] learnSkill error:', e.message); bot.chat('Something went wrong while learning.'); })
          .finally(() => { skillLearnInProgress = false; });
        return;
      }

      // !nilo do <skillName> — run a saved skill
      const doMatch = message.match(/^!nilo do\s+(\S+)/i);
      if (doMatch) {
        const skillName = doMatch[1].trim().toLowerCase();
        bot.chat(`Running skill: ${skillName}...`);
        skillEngine.runSkill(bot, skillName)
          .then(({ success, result, error }) => {
            bot.chat(success ? `Done: ${String(result ?? skillName).slice(0, 60)}` : `Skill failed: ${error}`);
          })
          .catch(e => bot.chat(`Error: ${e.message}`));
        return;
      }

      // !nilo skills — list all learned skills
      if (lower.match(/^!nilo skills?\b/)) {
        const list = skillEngine.listSkills();
        // Split across multiple chat messages if long
        const chunks = list.match(/.{1,200}(?:\s|$)/g) || [list];
        for (const chunk of chunks) bot.chat(chunk.trim());
        return;
      }

      // !nilo forget <skillName> — delete a skill
      const forgetMatch = message.match(/^!nilo forget\s+(\S+)/i);
      if (forgetMatch) {
        const skillName = forgetMatch[1].trim().toLowerCase();
        const ok = skillEngine.deleteSkill(skillName);
        bot.chat(ok ? `Forgot skill: ${skillName}.` : `No skill named ${skillName}.`);
        return;
      }

      // !nilo queue <task> — add a task to the autonomous curriculum
      const queueMatch = message.match(/^!nilo queue\s+(.+)/i);
      if (queueMatch) {
        skillEngine.queueGoal(queueMatch[1].trim());
        bot.chat(`Added to curriculum: "${queueMatch[1].trim().slice(0, 50)}"`);
        return;
      }

      // !nilo autonomous on/off — toggle autonomous skill learning
      if (lower.match(/^!nilo autonomous on\b/)) {
        autonomousSkillsEnabled = true;
        bot.chat(`Autonomous mode ON. I will learn new skills when idle. (${skillEngine.skillCount()} skills known)`);
        return;
      }
      if (lower.match(/^!nilo autonomous off\b/)) {
        autonomousSkillsEnabled = false;
        bot.chat('Autonomous mode OFF.');
        return;
      }
      if (lower.match(/^!nilo autonomous\b/)) {
        bot.chat(`Autonomous mode is currently ${autonomousSkillsEnabled ? 'ON' : 'OFF'}. Use !nilo autonomous on/off.`);
        return;
      }

      // Trust management
      const trustMatch = message.match(/^!nilo trust (\S+)/i);
      if (trustMatch) {
        trustPlayer(trustMatch[1]);
        bot.chat(`${trustMatch[1]} is now trusted.`);
        return;
      }
      const untrustMatch = message.match(/^!nilo (?:untrust|distrust) (\S+)/i);
      if (untrustMatch) {
        untrustPlayer(untrustMatch[1]);
        bot.chat(`${untrustMatch[1]} is no longer trusted.`);
        return;
      }
      if (lower.match(/^!nilo trusted\b/)) {
        const cfg = loadConfig();
        const list = (cfg.trusted || []).join(', ');
        bot.chat(list ? `Trusted: ${list}` : 'No trusted players.');
        return;
      }
    }

    // ── Behavior commands for trusted non-master players ──────────────────────
    if (username !== MASTER) {
      if (!isTrusted(username)) {
        // Untrusted — just chat, no commands
      } else {
        // Trusted — check if master has priority
        const masterLocked = behaviorOwner === MASTER;

        if (lower.match(/^!nilo follow\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${behaviorOwner}'s orders right now.`); return; }
          startFollow(bot, username, 2);
          bot.chat(`Following you, ${username}.`);
          return;
        }
        if (lower.match(/^!nilo stay\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${behaviorOwner}'s orders right now.`); return; }
          setBehavior(bot, 'idle', username); bot.chat('Staying put.'); return;
        }
        if (lower.match(/^!nilo sit\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${behaviorOwner}'s orders right now.`); return; }
          setBehavior(bot, 'sit', username); bot.setControlState('sneak', true); bot.chat('Sitting.'); return;
        }
        if (lower.match(/^!nilo wander\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${behaviorOwner}'s orders right now.`); return; }
          setBehavior(bot, 'wander', username); bot.chat('Going for a wander.'); return;
        }
        if (lower.match(/^!nilo attack\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${behaviorOwner}'s orders right now.`); return; }
          startAttack(bot, username);
          return;
        }
        if (lower.match(/^!nilo defensive\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${behaviorOwner}'s orders right now.`); return; }
          setBehavior(bot, 'defensive', username); bot.chat('Defensive mode.'); return;
        }
        if (lower.match(/^!nilo passive\b/)) {
          if (masterLocked) { bot.chat(`I'm following ${behaviorOwner}'s orders right now.`); return; }
          setBehavior(bot, 'passive', username); bot.chat('Passive mode.'); return;
        }
      }
    }

    // Strip trigger words to get the actual message
    const cleaned = message
      .replace(/!nilo\s*/i, '')
      .replace(/\bnilo\b[,:]?\s*/i, '')
      .trim();

    if (!cleaned) {
      bot.chat(`Hey ${username}.`);
      return;
    }

    console.log(`[NILO] ${username}: ${cleaned}`);

    try {
      const inv = getInventorySummary(bot);
      const held = bot.heldItem ? bot.heldItem.name : 'nothing';
      const lang = detectLanguage(cleaned);
      const actionHint = `[Available actions — if the message implies one, append [ACTION: name] at the very end of your reply: follow, stay, sit, stop, come, closer, unstuck, dance, fish, stop_fish, bow, build_house, sleep, wander, attack, defensive, passive, explore, stop_explore, collect_grave]`;
      const ctx = `${sessionHintFor(username)}${username} says: ${cleaned}\n[My inventory: ${inv}. Holding: ${held}. Respond in: ${lang}]\n${actionHint}`;
      const raw = await queryLetta(ctx);
      const { text, action } = parseAction(raw);
      console.log(`[NILO] -> ${text}${action ? ` [ACTION: ${action}]` : ''}`);
      lastInteractionTime = Date.now();
      if (text) bot.chat(text);
      if (action) dispatchAction(bot, action, username);
    } catch (err) {
      console.error('[NILO] Letta error:', err.message);
      bot.chat('My thoughts are unclear right now. Try again in a moment.');
    }
  });

  bot.on('death', () => {
    console.log('[NILO] Died. Respawning...');
    isFarming = false;
    isLooting = false;
    justDied = true;
    clearBehavior(bot);
    behaviorMode = 'idle';
    bot.respawn();
  });

  bot.on('spawn', async () => {
    if (!justDied) return;
    justDied = false;
    // Give the world a moment to load the grave block
    await new Promise(r => setTimeout(r, 3000));
    console.log('[NILO] Looking for grave after death...');
    await collectGrave(bot);
  });

  // Defensive mode: retaliate against whatever last hurt NILO
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;
    if (behaviorMode !== 'defensive') return;
    const attacker = bot.nearestEntity(e =>
      e !== bot.entity && e.position.distanceTo(bot.entity.position) < 8
    );
    if (!attacker) return;
    equipShield(bot);
    equipBestMeleeWeapon(bot);
    bot.activateItem(true); // raise shield immediately on hit
    bot.lookAt(attacker.position.offset(0, attacker.height * 0.9, 0), true)
      .then(() => bot.attack(attacker))
      .catch(() => {});
  });

  bot.on('error', (err) => {
    if (err.name === 'PartialReadError') return;
    console.error('[NILO] Bot error:', err.message);
  });

  bot.on('end', () => {
    activeBotRef = null;
    isFarming = false;
    if (behaviorInterval) { clearInterval(behaviorInterval); behaviorInterval = null; }
    if (proximityInterval) { clearInterval(proximityInterval); proximityInterval = null; }
    if (autonomousInterval) { clearInterval(autonomousInterval); autonomousInterval = null; }
    isLooting = false;
    behaviorMode = 'idle';
    console.log('[NILO] Disconnected. Reconnecting in 10s...');
    setTimeout(createBot, 10000);
  });
}

// ── Action parsing & dispatch ─────────────────────────────────────────────────

function parseAction(raw) {
  const m = raw.match(/\[ACTION:\s*(\w+)\]\s*$/i);
  if (!m) return { text: raw, action: null };
  return {
    text: raw.slice(0, m.index).trim(),
    action: m[1].toLowerCase(),
  };
}

function dispatchAction(bot, action, username) {
  console.log(`[NILO] LLM-dispatched action: ${action}`);
  switch (action) {
    case 'follow':
      bot.setControlState('sneak', false);
      startFollow(bot, username, 2);
      break;
    case 'stay':
    case 'stop':
      setBehavior(bot, 'idle', username);
      break;
    case 'sit':
      setBehavior(bot, 'sit', username);
      bot.setControlState('sneak', true);
      break;
    case 'come': {
      setBehavior(bot, 'idle', username);
      const t = bot.players[username]?.entity;
      if (t) {
        const movements = createMovements(bot);
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.setGoal(new GoalNear(t.position.x, t.position.y, t.position.z, 2));
      }
      break;
    }
    case 'closer':
      startFollow(bot, username, 1);
      break;
    case 'unstuck':
      tryUnstuck(bot)
        .then(ok => { if (!ok) bot.chat("Completely stuck. Can you give me a hand?"); })
        .catch(err => console.error('[NILO] Unstuck error:', err.message));
      break;
    case 'dance':
      startDance(bot);
      break;
    case 'fish':
      startFishing(bot);
      break;
    case 'stop_fish':
      if (behaviorMode === 'fishing') { setBehavior(bot, 'idle', username); bot.deactivateItem(); }
      break;
    case 'bow':
      startBowMode(bot);
      break;
    case 'build_house':
      buildSimpleHouse(bot);
      break;
    case 'sleep':
      sleepInBed(bot);
      break;
    case 'wander':
      setBehavior(bot, 'wander', username);
      break;
    case 'attack':
      startAttack(bot, username);
      break;
    case 'defensive':
      setBehavior(bot, 'defensive', username);
      break;
    case 'passive':
      setBehavior(bot, 'passive', username);
      break;
    case 'explore':
      exploringEnabled = true;
      setBehavior(bot, 'idle', username);
      break;
    case 'stop_explore':
      exploringEnabled = false;
      setBehavior(bot, 'idle', username);
      break;
    case 'collect_grave':
      collectGrave(bot)
        .catch(err => console.error('[NILO] Grave collect error:', err.message));
      break;
    default:
      console.warn(`[NILO] Unknown LLM action: ${action}`);
  }
}

// ── Command runner ────────────────────────────────────────────────────────────
// bot.chat('/command') goes through mineflayer's routing logic which in offline
// mode may fall back to a plain chat packet — the 1.20.1 server does not execute
// a chat_message packet starting with '/' as a command.
// Write the chat_command packet directly so it always goes to the right handler.

function runCommand(bot, command) {
  const cmd = command.startsWith('/') ? command.slice(1) : command;
  try {
    bot._client.write('chat_command', {
      command:            cmd,
      timestamp:          BigInt(Date.now()),
      salt:               0n,
      argumentSignatures: [],
      messageCount:       0,
      acknowledged:       Buffer.alloc(3, 0),
    });
    console.log(`[NILO] Sent chat_command: ${cmd}`);
  } catch (err) {
    // Fallback: let mineflayer try its own routing
    console.warn(`[NILO] chat_command write failed (${err.message}), falling back to bot.chat`);
    bot.chat(`/${cmd}`);
  }
}

// ── Letta ─────────────────────────────────────────────────────────────────────

async function queryLetta(userMessage) {
  const { default: fetch } = await import('node-fetch');

  const res = await fetch(LETTA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  for (const msg of data.messages || []) {
    if (msg.message_type === 'assistant_message' && msg.content) {
      // Strip emojis and trim
      return msg.content.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();
    }
  }

  throw new Error('No assistant_message response from Letta');
}

// ── Boot ──────────────────────────────────────────────────────────────────────

watchLog();
createBot();
