(() => {
  'use strict';

  const EVENT_NAME = 'InfinityHelpData';
  const MOVE_RESCAN_EVENT_NAME =
    'InfinityHelpMoveRescanRequest';
  const STORAGE_KEY = 'infinityHelpSettings';
  const MOVE_CACHE_STORAGE_KEY =
    'infinityHelpPlayerMoveCacheV1';

  const EVENT_TIME_ZONE =
    'America/Sao_Paulo';

  // The user confirmed that the event Pokémon appeared in the
  // 13:00 Brasília window on 2026-08-01.
  const EVENT_INITIAL_CONFIRMED_SLOT =
    '2026-08-01T13:00';

  const EVENT_WINDOW_ACTIVE_MS = 60000;

  const LOGO_URL = chrome.runtime.getURL(
    'assets/infinityhelp-logo.png'
  );

  // Used only when an NPC payload does not include the Pokémon types.
  // The original v0.2 wild encounter flow does not depend on this data.
  const PokemonData =
    globalThis.InfinityHelpPokemonData || {
      byId: {},
      byName: {}
    };

  const MoveData =
    globalThis.InfinityHelpMoveData || {
      byName: {}
    };

  const CaptureData =
    globalThis.InfinityHelpCaptureData || {
      byId: {}
    };

  const ItemData =
    globalThis.InfinityHelpItemData || {
      byKey: {},
      byId: {},
      nonFullyEvolvedSpecies: []
    };

  const ITEM_NFE_SPECIES = new Set(
    ItemData.nonFullyEvolvedSpecies || []
  );

  const defaults = {
    enabled: true,
    diagnostic: false,
    collapsed: false,
    panelX: 8,
    panelY: 72,
    panelWidth: 330,
    panelHeight: null,
    ivsCollapsed: false,
    effectsCollapsed: false,
    recommendationCollapsed: false,
    koCollapsed: false,
    captureCollapsed: false,
    captureRoundUp: false,
    eventLastConfirmedSlot:
      EVENT_INITIAL_CONFIRMED_SLOT,
    eventLastOneMinuteAlertSlot: null,
    eventLastThirtySecondAlertSlot: null
  };

  let settings = { ...defaults };
  let panel = null;
  let body = null;
  let diagnosticPre = null;
  let activeEncounter = null;
  let encounterTimer = null;
  let endConfirmationTimer = null;

  // Full opponent records found during the current NPC battle.
  // Used when the game switches to a new foe and sends only name/level/HP.
  const npcBattleRecordCache = new Map();

  // Player party detected from game payloads or game storage.
  // Recommendation is based only on Pokémon types.
  let playerTeam = [];
  let playerTeamUpdatedAt = 0;

  // Battle-authoritative player roster by party slot.
  // Used to exclude fainted Pokémon and prove that a recommendation
  // really belongs to the current player's party.
  let activeBattlePartyAvailability = new Map();
  let activeBattlePartyBattleId = null;

  // A ordem do time define o Pokémon que inicia a próxima batalha.
  // Uma leitura recente de rede não pode ser substituída por um
  // snapshot antigo de localStorage/sessionStorage.
  let playerTeamLayoutAuthority = 0;
  let playerTeamLayoutUpdatedAt = 0;

  // Persisted only from move data that the game actually exposed.
  // PP is intentionally not persisted because it changes during battle.
  let playerMoveCache = {};
  let moveCacheSaveTimer = null;
  let moveRescanTimer = null;
  let moveRescanAttempt = 0;
  let lastMoveRescanAt = 0;

  // Detailed records already delivered by /api/character, including PC boxes.
  // They are used only to enrich a matching active battler with Atq/AtE/etc.
  // No extra request is made and ambiguous duplicate matches are rejected.
  let playerPokemonDetailCache = [];
  const PLAYER_POKEMON_DETAIL_CACHE_LIMIT = 1200;

  // Player Pokémon currently on the battlefield.
  let activePlayerPokemon = null;
  let activePlayerPokemonSource = null;
  let activePlayerPokemonUpdatedAt = 0;

  // Once state.you.mon is received from a live battle packet, party/PC
  // refreshes may enrich that exact Pokémon but can never replace its identity.
  let activeBattleAuthorityEstablished = false;
  let activeBattleAuthoritySlot = null;
  let activeBattleAuthorityUpdatedAt = 0;

  // Live opponent state delivered by InfinityMMO battle v2 packets.
  // This is used only by CHANCE DE MATAR so KO classification compares
  // against the foe's current HP, never a cached/full-stat maximum HP.
  let activeOpponentBattleState = null;

  let activePlayerDomConfirmedAt = 0;
  let activePlayerDomLockedKey = null;

  // Authoritative active-player state derived from ordered battle events:
  // switch_out(you) -> switch_in(you, slot, mon).
  let activePlayerSwitchEventKey = null;
  let activePlayerSwitchEventSlot = null;
  let activePlayerSwitchEventPokemon = null;
  let activePlayerSwitchEventUpdatedAt = 0;

  let activePlayerDomSyncTimer = null;
  let activePlayerDomObserver = null;

  // A possible missing foe is given a long grace period. Any opponent
  // update received during this period cancels the close request.
  const FOE_GONE_CONFIRMATION_MS = 8000;

  // Explicit results such as escaped/captured/victory are still delayed
  // briefly so a following opponent-switch packet can cancel them.
  const TERMINAL_RESULT_CONFIRMATION_MS = 1800;

  const labels = {
    hp: 'PS',
    atk: 'Atq',
    def: 'Def',
    spa: 'AtE',
    spd: 'DeE',
    spe: 'Vel'
  };

  const statAliases = {
    hp: [
      'hpIv', 'ivHp', 'hp_iv', 'iv_hp',
      'psIv', 'ivPs', 'ps_iv', 'iv_ps'
    ],
    atk: [
      'atkIv', 'ivAtk', 'atk_iv', 'iv_atk',
      'attackIv', 'ivAttack', 'attack_iv'
    ],
    def: [
      'defIv', 'ivDef', 'def_iv', 'iv_def',
      'defenseIv', 'ivDefense', 'defense_iv'
    ],
    spa: [
      'spaIv', 'ivSpa', 'spa_iv', 'iv_spa',
      'spAtkIv', 'ivSpAtk',
      'specialAttackIv', 'special_attack_iv'
    ],
    spd: [
      'spdIv', 'ivSpd', 'spd_iv', 'iv_spd',
      'spDefIv', 'ivSpDef',
      'specialDefenseIv', 'special_defense_iv'
    ],
    spe: [
      'speIv', 'ivSpe', 'spe_iv', 'iv_spe',
      'speedIv', 'ivSpeed', 'speed_iv'
    ]
  };

  const genericStatAliases = {
    hp: ['hp', 'ps', 'health', 'maxHp', 'max_hp'],
    atk: ['atk', 'attack', 'atq'],
    def: ['def', 'defense'],
    spa: ['spa', 'spatk', 'specialAttack', 'special_attack', 'ate'],
    spd: ['spd', 'spdef', 'specialDefense', 'special_defense', 'dee'],
    spe: ['spe', 'speed', 'vel']
  };

  const TYPE_NAMES = [
    'normal', 'fire', 'water', 'electric', 'grass', 'ice',
    'fighting', 'poison', 'ground', 'flying', 'psychic',
    'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'
  ];

  const TYPE_LABELS = {
    normal: 'Normal',
    fire: 'Fogo',
    water: 'Água',
    electric: 'Elétrico',
    grass: 'Grama',
    ice: 'Gelo',
    fighting: 'Lutador',
    poison: 'Veneno',
    ground: 'Terra',
    flying: 'Voador',
    psychic: 'Psíquico',
    bug: 'Inseto',
    rock: 'Pedra',
    ghost: 'Fantasma',
    dragon: 'Dragão',
    dark: 'Sombrio',
    steel: 'Aço',
    fairy: 'Fada'
  };

  const TYPE_ABBR = {
    normal: 'Nor',
    fire: 'Fog',
    water: 'Águ',
    electric: 'Ele',
    grass: 'Gra',
    ice: 'Gel',
    fighting: 'Lut',
    poison: 'Ven',
    ground: 'Ter',
    flying: 'Voa',
    psychic: 'Psi',
    bug: 'Ins',
    rock: 'Ped',
    ghost: 'Fan',
    dragon: 'Dra',
    dark: 'Som',
    steel: 'Aço',
    fairy: 'Fad'
  };

  const TYPE_ALIASES = {
    normal: 'normal',
    fire: 'fire',
    fogo: 'fire',
    water: 'water',
    agua: 'water',
    água: 'water',
    electric: 'electric',
    eletrico: 'electric',
    elétrico: 'electric',
    lightning: 'electric',
    grass: 'grass',
    grama: 'grass',
    plant: 'grass',
    planta: 'grass',
    ice: 'ice',
    gelo: 'ice',
    fighting: 'fighting',
    fighter: 'fighting',
    lutador: 'fighting',
    luta: 'fighting',
    poison: 'poison',
    veneno: 'poison',
    ground: 'ground',
    terra: 'ground',
    flying: 'flying',
    voador: 'flying',
    psychic: 'psychic',
    psiquico: 'psychic',
    psíquico: 'psychic',
    bug: 'bug',
    inseto: 'bug',
    rock: 'rock',
    pedra: 'rock',
    ghost: 'ghost',
    fantasma: 'ghost',
    dragon: 'dragon',
    dragao: 'dragon',
    dragão: 'dragon',
    dark: 'dark',
    sombrio: 'dark',
    noturno: 'dark',
    steel: 'steel',
    aco: 'steel',
    aço: 'steel',
    fairy: 'fairy',
    fada: 'fairy'
  };

  // Attacking type -> defensive type multipliers.
  const TYPE_CHART = {
    normal:   { rock: 0.5, ghost: 0, steel: 0.5 },
    fire:     { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
    water:    { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
    electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
    grass:    { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
    ice:      { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
    fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5 },
    poison:   { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
    ground:   { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
    flying:   { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
    psychic:  { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
    bug:      { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5, fairy: 0.5 },
    rock:     { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
    ghost:    { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
    dragon:   { dragon: 2, steel: 0.5, fairy: 0 },
    dark:     { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
    steel:    { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
    fairy:    { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 }
  };

  const POSITIVE_CONTEXT =
    /wild|encounter|battle|opponent|enemy|foe|combat|duel/i;

  const NEGATIVE_CONTEXT =
    /pc_json|pokemon.?center|storage|collection|owned|party|team|box|inventory|pokedex|pok[eé]dex/i;

  const END_SIGNAL =
    /battle.?end|end.?battle|encounter.?end|end.?encounter|combat.?end|fled|escaped|captured|capture.?success|battle.?finished|encounter.?finished/i;

  // Separate NPC-only detection. The original wild regexes and scoring
  // above remain unchanged.
  const NPC_SIGNAL =
    /trainer|npc|treinador|rival|gym|leader|lider|boss|duel/i;

  const NPC_OPPONENT_CONTEXT =
    /opponent|enemy|foe|adversar|inimig|rival/i;

  const NPC_OWN_CONTEXT =
    /(^|[._\[\]-])(player|self|mine|my|ally|party|owned|collection|pcjson|storage|box)([._\[\]-]|$)/i;

  function normalizeKey(key) {
    return String(key)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
  }

  function normalizeType(value) {
    if (value == null) return null;

    if (typeof value === 'object') {
      value =
        value.name ??
        value.type ??
        value.label ??
        value.slug ??
        value.id ??
        null;
    }

    if (value == null) return null;

    const key = String(value)
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    return TYPE_ALIASES[key] || null;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function getByAliases(obj, aliases) {
    if (!obj || typeof obj !== 'object') return undefined;

    const map = new Map(
      Object.keys(obj).map(key => [normalizeKey(key), key])
    );

    for (const alias of aliases) {
      const actual = map.get(normalizeKey(alias));
      if (actual !== undefined) return obj[actual];
    }

    return undefined;
  }

  const HELD_ITEM_ALIASES = [
    'heldItem',
    'held_item',
    'helditem',
    'itemHeld',
    'item_held',
    'equippedItem',
    'equipped_item',
    'heldObject',
    'held_object'
  ];

  function itemDataEntry(value) {
    if (value == null) return null;

    if (typeof value === 'number') {
      const key =
        ItemData.byId?.[String(value)];

      return key
        ? ItemData.byKey?.[key] || null
        : null;
    }

    const key = normalizeKey(value);

    return key
      ? ItemData.byKey?.[key] || null
      : null;
  }

  function normalizeHeldItemValue(value) {
    if (
      value == null ||
      value === false ||
      value === 0
    ) {
      return null;
    }

    if (typeof value === 'number') {
      const entry = itemDataEntry(value);

      return entry?.identifier || null;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();

      if (
        !trimmed ||
        /^(?:none|null|noitem|semitem|empty)$/i
          .test(normalizeKey(trimmed))
      ) {
        return null;
      }

      const entry = itemDataEntry(trimmed);

      return entry?.identifier || trimmed;
    }

    if (typeof value !== 'object') {
      return null;
    }

    const nested =
      getByAliases(value, [
        'identifier',
        'slug',
        'itemName',
        'item_name',
        'name',
        'value',
        'id'
      ]);

    if (nested === value) {
      return null;
    }

    return normalizeHeldItemValue(nested);
  }

  function extractHeldItemState(object) {
    if (!object || typeof object !== 'object') {
      return {
        observed: false,
        value: null
      };
    }

    const keys = new Map(
      Object.keys(object).map(key => [
        normalizeKey(key),
        key
      ])
    );

    for (const alias of HELD_ITEM_ALIASES) {
      const actual =
        keys.get(normalizeKey(alias));

      if (actual === undefined) continue;

      return {
        observed: true,
        value:
          normalizeHeldItemValue(
            object[actual]
          )
      };
    }

    // Some character snapshots use a generic "item" field.
    // Accept it only when it resolves to an item from the local base.
    const genericKey = keys.get('item');

    if (genericKey !== undefined) {
      const candidate =
        normalizeHeldItemValue(
          object[genericKey]
        );

      if (
        candidate &&
        itemDataEntry(candidate)
      ) {
        return {
          observed: true,
          value: candidate
        };
      }
    }

    return {
      observed: false,
      value: null
    };
  }

  function heldItemDisplayName(value) {
    const entry = itemDataEntry(value);

    if (entry?.name) {
      return entry.name;
    }

    if (!value) return null;

    return String(value)
      .replace(/[_-]+/g, ' ')
      .trim()
      .replace(/\b\w/g, char =>
        char.toUpperCase()
      );
  }

  function numberInRange(value, min, max) {
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max
      ? n
      : null;
  }

  function extractIvSet(obj) {
    if (
      !obj ||
      typeof obj !== 'object' ||
      Array.isArray(obj)
    ) {
      return null;
    }

    const directContainer = getByAliases(obj, [
      'ivs',
      'iv',
      'individualValues',
      'individual_values',
      'individualStats',
      'individual_stats'
    ]);

    const sources = [];
    if (
      directContainer &&
      typeof directContainer === 'object'
    ) {
      sources.push(directContainer);
    }
    sources.push(obj);

    for (const source of sources) {
      const result = {};

      for (const stat of Object.keys(statAliases)) {
        let value = getByAliases(source, statAliases[stat]);

        if (
          value === undefined &&
          source !== obj
        ) {
          value = getByAliases(
            source,
            genericStatAliases[stat]
          );
        }

        const parsed = numberInRange(value, 0, 31);
        if (parsed !== null) result[stat] = parsed;
      }

      if (Object.keys(result).length >= 4) return result;
    }

    return null;
  }

  function extractStats(obj) {
    if (
      !obj ||
      typeof obj !== 'object' ||
      Array.isArray(obj)
    ) {
      return {};
    }

    const container = getByAliases(obj, [
      'stats',
      'currentStats',
      'current_stats',
      'battleStats',
      'battle_stats'
    ]);

    const source =
      container && typeof container === 'object'
        ? container
        : obj;

    const out = {};

    for (const stat of Object.keys(genericStatAliases)) {
      const value = getByAliases(
        source,
        genericStatAliases[stat]
      );
      const parsed = numberInRange(value, 0, 99999);

      if (parsed !== null) out[stat] = parsed;
    }

    return out;
  }

  function extractTypes(obj) {
    if (!obj || typeof obj !== 'object') return [];

    const candidates = [];

    const direct = getByAliases(obj, [
      'types',
      'pokemonTypes',
      'pokemon_types'
    ]);

    if (Array.isArray(direct)) {
      candidates.push(...direct);
    } else if (direct != null) {
      candidates.push(direct);
    }

    for (const alias of [
      'type',
      'type1',
      'type2',
      'primaryType',
      'secondaryType',
      'pokemonType',
      'pokemon_type'
    ]) {
      const value = getByAliases(obj, [alias]);
      if (value != null) candidates.push(value);
    }

    const result = [];

    for (const candidate of candidates) {
      const type = normalizeType(candidate);
      if (type && !result.includes(type)) result.push(type);
    }

    return result.slice(0, 2);
  }

  function extractMeta(obj) {
    if (!obj || typeof obj !== 'object') return {};

    const name = getByAliases(obj, [
      'pokemonName',
      'pokemon_name',
      'speciesName',
      'species_name',
      'displayName',
      'display_name',
      'name',
      'species'
    ]);

    const level = getByAliases(obj, [
      'level',
      'lvl',
      'pokemonLevel',
      'pokemon_level'
    ]);

    const nature = getByAliases(obj, [
      'nature',
      'natureName',
      'nature_name'
    ]);

    const ability = getByAliases(obj, [
      'ability',
      'abilityName',
      'ability_name',
      'habilidade'
    ]);

    const bst = getByAliases(obj, [
      'bst',
      'baseStatTotal',
      'base_stat_total'
    ]);

    const rawShiny = getByAliases(obj, [
      'shiny',
      'isShiny',
      'is_shiny'
    ]);

    const heldItemState =
      extractHeldItemState(obj);

    return {
      name:
        typeof name === 'string'
          ? name
          : (
              name &&
              typeof name === 'object' &&
              typeof name.name === 'string'
                ? name.name
                : null
            ),
      level: numberInRange(level, 1, 999),
      nature:
        typeof nature === 'string'
          ? nature
          : (
              nature &&
              typeof nature === 'object' &&
              typeof nature.name === 'string'
                ? nature.name
                : null
            ),
      ability:
        typeof ability === 'string'
          ? ability
          : (
              ability &&
              typeof ability === 'object' &&
              typeof ability.name === 'string'
                ? ability.name
                : null
            ),
      bst: numberInRange(bst, 1, 9999),
      shiny:
        rawShiny == null
          ? null
          : booleanLike(rawShiny),
      heldItem:
        heldItemState.value,
      heldItemObserved:
        heldItemState.observed,
      types: extractTypes(obj)
    };
  }


function extractNpcSpeciesId(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const direct = getByAliases(obj, [
    'speciesId',
    'species_id',
    'pokemonId',
    'pokemon_id',
    'pokedexId',
    'pokedex_id',
    'dexId',
    'dex_id',
    'nationalDex',
    'national_dex',
    'number'
  ]);

  const parsed = numberInRange(direct, 1, 99999);
  if (parsed !== null) return parsed;

  const genericId = numberInRange(
    getByAliases(obj, ['id']),
    1,
    1351
  );

  return genericId;
}

function withNpcTypeFallback(meta, obj) {
  if (meta.types && meta.types.length) return meta;

  const speciesId = extractNpcSpeciesId(obj);

  if (
    speciesId !== null &&
    PokemonData.byId[String(speciesId)]
  ) {
    const entry = PokemonData.byId[String(speciesId)];
    return {
      ...meta,
      types: Array.isArray(entry[1]) ? entry[1] : []
    };
  }

  const nameKey = normalizeKey(meta.name || '');
  const nameEntry = PokemonData.byName[nameKey];

  if (nameEntry) {
    return {
      ...meta,
      types: Array.isArray(nameEntry[1])
        ? nameEntry[1]
        : []
    };
  }

  return meta;
}

function hasNpcTrainerFlag(obj) {
  const value = getByAliases(obj, [
    'trainer',
    'isTrainer',
    'is_trainer',
    'trainerBattle',
    'trainer_battle',
    'npcBattle',
    'npc_battle'
  ]);

  return (
    value === true ||
    value === 1 ||
    value === '1'
  );
}

function hasNpcOpponentFlag(obj) {
  const side = normalizeKey(
    getByAliases(obj, [
      'side',
      'owner',
      'role',
      'position',
      'teamSide',
      'team_side'
    ]) || ''
  );

  return /opponent|enemy|foe|rival/.test(side);
}


const STRONG_NPC_MODE_VALUES = new Set([
  'npc',
  'npcbattle',
  'trainer',
  'trainerbattle',
  'gym',
  'gymbattle',
  'leader',
  'leaderbattle',
  'boss',
  'bossbattle'
]);

const STRONG_WILD_MODE_VALUES = new Set([
  'wild',
  'wildbattle',
  'wildencounter',
  'encounter'
]);

const STRONG_NPC_NAME_KEY =
  /^(trainername|opponenttrainername|enemytrainername|npcname|rivalname|leadername|bossname)$/;

const STRONG_BATTLE_MODE_KEY =
  /^(battletype|battlemode|battlekind|encountertype|encountermode|combatmode|dueltype|mode|kind)$/;

function visibleGameTextSamples(
  maximum = 3200
) {
  const output = [];
  const seen = new Set();

  const elements = [
    ...document.querySelectorAll(
      'div,span,strong,b,p,h1,h2,h3,h4,h5,h6,button,[role="button"]'
    )
  ].slice(0, maximum);

  for (const element of elements) {
    if (
      !elementIsVisibleForActiveMove(element) ||
      element.closest('#infinity-help-panel')
    ) {
      continue;
    }

    const text =
      String(element.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();

    if (
      !text ||
      text.length > 150 ||
      seen.has(text)
    ) {
      continue;
    }

    seen.add(text);
    output.push(text);
  }

  return output;
}

function visibleWildBattleEvidence() {
  for (const text of visibleGameTextSamples()) {
    const normalized = normalizeKey(text);

    if (
      (
        normalized.includes('selvagem') &&
        (
          normalized.includes('apareceu') ||
          normalized.includes('surgiu')
        )
      ) ||
      (
        normalized.includes('wild') &&
        normalized.includes('appeared')
      ) ||
      (
        normalized.includes('salvaje') &&
        (
          normalized.includes('aparecio') ||
          normalized.includes('aparecio')
        )
      )
    ) {
      return true;
    }
  }

  return false;
}

function explicitWildBattleEvidence(root) {
  if (!root || typeof root !== 'object') {
    return false;
  }

  const queue = [root];
  const seen = new WeakSet();
  let inspected = 0;

  while (queue.length && inspected < 3000) {
    const current = queue.shift();
    inspected++;

    if (
      !current ||
      typeof current !== 'object' ||
      seen.has(current)
    ) {
      continue;
    }

    seen.add(current);

    if (hasWildFlag(current)) {
      return true;
    }

    for (
      const [key, item] of
      Object.entries(current).slice(0, 260)
    ) {
      const normalizedKey =
        normalizeKey(key);

      if (
        STRONG_BATTLE_MODE_KEY.test(
          normalizedKey
        ) &&
        typeof item === 'string' &&
        STRONG_WILD_MODE_VALUES.has(
          normalizeKey(item)
        )
      ) {
        return true;
      }

      if (
        /^(wild|iswild|wildbattle|wildencounter)$/
          .test(normalizedKey) &&
        (
          item === true ||
          item === 1 ||
          item === '1'
        )
      ) {
        return true;
      }

      if (item && typeof item === 'object') {
        queue.push(item);
      }
    }
  }

  return false;
}

function strongNpcBattleEvidence(
  root,
  detail = null
) {
  if (!root || typeof root !== 'object') {
    return false;
  }

  if (
    explicitWildBattleEvidence(root) ||
    visibleWildBattleEvidence()
  ) {
    return false;
  }

  const sourceText = [
    detail?.meta?.url,
    detail?.source
  ]
    .filter(Boolean)
    .join(' ');

  if (
    /(?:^|[/?_.-])(npc|trainer|gym|leader|boss)(?:[/?_.-]|$)/i
      .test(sourceText)
  ) {
    return true;
  }

  const queue = [{
    value: root,
    path: '$'
  }];

  const seen = new WeakSet();
  let inspected = 0;

  while (queue.length && inspected < 4200) {
    const current = queue.shift();
    inspected++;

    if (
      !current.value ||
      typeof current.value !== 'object' ||
      seen.has(current.value)
    ) {
      continue;
    }

    seen.add(current.value);

    if (hasNpcTrainerFlag(current.value)) {
      return true;
    }

    for (
      const [key, item] of
      Object.entries(current.value).slice(0, 300)
    ) {
      const normalizedKey =
        normalizeKey(key);

      if (
        STRONG_NPC_NAME_KEY.test(
          normalizedKey
        ) &&
        typeof item === 'string' &&
        item.trim().length >= 2 &&
        item.trim().length <= 80
      ) {
        return true;
      }

      if (
        STRONG_BATTLE_MODE_KEY.test(
          normalizedKey
        ) &&
        typeof item === 'string' &&
        STRONG_NPC_MODE_VALUES.has(
          normalizeKey(item)
        )
      ) {
        return true;
      }

      if (
        /^(npcbattle|trainerbattle|gymbattle|leaderbattle|bossbattle)$/
          .test(normalizedKey) &&
        (
          item === true ||
          item === 1 ||
          item === '1'
        )
      ) {
        return true;
      }

      if (
        item &&
        typeof item === 'object'
      ) {
        queue.push({
          value: item,
          path: `${current.path}.${key}`
        });
      }
    }
  }

  return false;
}

function determineEncounterMode(
  candidate,
  detail,
  root
) {
  if (
    hasWildFlag(candidate?.object) ||
    explicitWildBattleEvidence(root) ||
    visibleWildBattleEvidence()
  ) {
    return 'wild';
  }

  // A confirmed NPC battle remains NPC through sparse opponent-switch
  // packets unless strong wild evidence appears.
  if (activeEncounter?.mode === 'npc') {
    return 'npc';
  }

  // A confirmed wild encounter remains wild unless unmistakable
  // trainer/NPC evidence arrives.
  if (
    activeEncounter?.mode === 'wild' &&
    !strongNpcBattleEvidence(root, detail)
  ) {
    return 'wild';
  }

  return strongNpcBattleEvidence(
    root,
    detail
  )
    ? 'npc'
    : 'wild';
}

function containsNpcSignal(root) {
  return strongNpcBattleEvidence(
    root,
    null
  );
}

function scoreNpcObject(obj, path, detail) {
  if (!obj || typeof obj !== 'object') {
    return -9999;
  }

  if (hasWildFlag(obj)) {
    return -9999;
  }

  const context =
    objectContextText(
      obj,
      path,
      detail
    );

  if (NPC_OWN_CONTEXT.test(path)) {
    return -9999;
  }

  if (
    /pc_json|pokemon.?center|storage|collection|owned|box|inventory|pokedex|pok[eé]dex/i
      .test(context)
  ) {
    return -9999;
  }

  const ivs = extractIvSet(obj);
  const meta = extractMeta(obj);
  const stats = extractStats(obj);

  if (
    !meta.name &&
    !ivs &&
    Object.keys(stats).length < 4
  ) {
    return -9999;
  }

  let score = 0;

  if (meta.name) score += 22;
  if (meta.level) score += 10;
  if (meta.nature) score += 6;
  if (meta.ability) score += 6;
  if (meta.types.length) score += 7;

  if (ivs) {
    score +=
      Object.keys(ivs).length * 12;
  }

  score +=
    Object.keys(stats).length * 3;

  if (hasNpcTrainerFlag(obj)) {
    score += 100;
  }

  if (
    strongNpcBattleEvidence(
      obj,
      detail
    )
  ) {
    score += 90;
  }

  if (
    NPC_OPPONENT_CONTEXT.test(context) ||
    hasNpcOpponentFlag(obj)
  ) {
    score += 35;
  }

  if (
    detail.source === 'localStorage' ||
    detail.source === 'sessionStorage'
  ) {
    score -= 25;
  }

  return score;
}

function findBestNpcCandidate(root, detail) {
  if (
    !root ||
    typeof root !== 'object' ||
    !containsNpcSignal(root)
  ) {
    return null;
  }

  const queue = [{ value: root, path: '$' }];
  const seen = new WeakSet();

  let best = null;
  let bestScore = -9999;
  let inspected = 0;

  while (queue.length && inspected < 7000) {
    const { value, path } = queue.shift();
    inspected++;

    if (
      !value ||
      typeof value !== 'object' ||
      seen.has(value)
    ) {
      continue;
    }

    seen.add(value);

    const score = scoreNpcObject(
      value,
      path,
      detail
    );

    if (score > bestScore) {
      best = {
        object: value,
        path,
        score
      };
      bestScore = score;
    }

    if (Array.isArray(value)) {
      value.slice(0, 400).forEach((item, index) => {
        if (item && typeof item === 'object') {
          queue.push({
            value: item,
            path: `${path}[${index}]`
          });
        }
      });
    } else {
      Object.entries(value)
        .slice(0, 500)
        .forEach(([key, item]) => {
          if (item && typeof item === 'object') {
            queue.push({
              value: item,
              path: `${path}.${key}`
            });
          }
        });
    }
  }

  return bestScore >= 55 ? best : null;
}

function findNpcTrainerName(root) {
  if (!root || typeof root !== 'object') return null;

  const queue = [root];
  const seen = new WeakSet();
  let fallback = null;
  let inspected = 0;

  while (queue.length && inspected < 2200) {
    const current = queue.shift();
    inspected++;

    if (
      !current ||
      typeof current !== 'object' ||
      seen.has(current)
    ) {
      continue;
    }

    seen.add(current);

    for (
      const [key, item] of
      Object.entries(current).slice(0, 220)
    ) {
      const normalized = normalizeKey(key);

      if (
        typeof item === 'string' &&
        item.length >= 2 &&
        item.length <= 80
      ) {
        if (
          /^(trainername|opponenttrainername|enemytrainername|npcname|rivalname|leadername)$/
            .test(normalized)
        ) {
          return item;
        }

        if (
          /trainer|npc|rival|leader|boss/
            .test(normalized)
        ) {
          fallback = fallback || item;
        }
      }

      if (item && typeof item === 'object') {
        queue.push(item);
      }
    }
  }

  return fallback;
}

function candidateLooksNpc(
  candidate,
  detail,
  root
) {
  if (
    !candidate ||
    hasWildFlag(candidate.object)
  ) {
    return false;
  }

  return (
    determineEncounterMode(
      candidate,
      detail,
      root
    ) === 'npc'
  );
}

  function objectContextText(obj, path, detail) {
    let keys = '';

    try {
      keys = Object.keys(obj || {}).slice(0, 100).join(' ');
    } catch (_) {}

    return [
      path,
      detail?.source,
      detail?.meta?.url,
      detail?.meta?.method,
      keys
    ]
      .filter(Boolean)
      .join(' ');
  }

  function hasWildFlag(obj) {
    const wild = getByAliases(obj, [
      'wild',
      'isWild',
      'is_wild',
      'wildPokemon',
      'wild_pokemon'
    ]);

    if (wild === true || wild === 1 || wild === '1') {
      return true;
    }

    const trainer = getByAliases(obj, [
      'trainer',
      'isTrainer',
      'is_trainer',
      'trainerBattle',
      'trainer_battle'
    ]);

    if (trainer === false || trainer === 0 || trainer === '0') {
      const context = Object.keys(obj).join(' ');
      if (POSITIVE_CONTEXT.test(context)) return true;
    }

    return false;
  }

  function scoreObject(obj, path, detail) {
    if (!obj || typeof obj !== 'object') return -9999;

    const ivs = extractIvSet(obj);
    if (!ivs) return -9999;

    const context = objectContextText(obj, path, detail);

    if (NEGATIVE_CONTEXT.test(context)) return -9999;

    let score = Object.keys(ivs).length * 12;
    const meta = extractMeta(obj);
    const stats = extractStats(obj);

    score +=
      Object.values(meta)
        .filter(value => {
          if (Array.isArray(value)) return value.length > 0;
          return value !== null && value !== undefined;
        })
        .length * 4;

    score += Object.keys(stats).length * 2;

    if (POSITIVE_CONTEXT.test(context)) score += 45;
    if (hasWildFlag(obj)) score += 55;

    if (
      detail.source === 'localStorage' ||
      detail.source === 'sessionStorage'
    ) {
      score -= 30;
    }

    // An IV object with no battle/wild context is likely an owned Pokémon.
    if (
      !POSITIVE_CONTEXT.test(context) &&
      !hasWildFlag(obj)
    ) {
      score -= 70;
    }

    return score;
  }

  function findBestCandidate(root, detail) {
    if (!root || typeof root !== 'object') return null;

    const queue = [{ value: root, path: '$' }];
    const seen = new WeakSet();

    let best = null;
    let bestScore = -9999;
    let inspected = 0;

    while (queue.length && inspected < 6500) {
      const { value, path } = queue.shift();
      inspected++;

      if (
        !value ||
        typeof value !== 'object' ||
        seen.has(value)
      ) {
        continue;
      }

      seen.add(value);

      const score = scoreObject(value, path, detail);

      if (score > bestScore) {
        best = { object: value, path, score };
        bestScore = score;
      }

      if (Array.isArray(value)) {
        value.slice(0, 350).forEach((item, index) => {
          if (item && typeof item === 'object') {
            queue.push({
              value: item,
              path: `${path}[${index}]`
            });
          }
        });
      } else {
        Object.entries(value)
          .slice(0, 450)
          .forEach(([key, item]) => {
            if (item && typeof item === 'object') {
              queue.push({
                value: item,
                path: `${path}.${key}`
              });
            }
          });
      }
    }

    return bestScore >= 45 ? best : null;
  }

function booleanLike(value) {
  if (
    value === true ||
    value === 1 ||
    value === '1'
  ) {
    return true;
  }

  if (typeof value === 'string') {
    return /^(true|yes|sim|success)$/i
      .test(value.trim());
  }

  return false;
}


function terminalBattleOutcome(value) {
  const normalized =
    normalizeKey(
      String(value ?? '')
    );

  return new Set([
    'win',
    'won',
    'victory',
    'battlewon',
    'lose',
    'lost',
    'defeat',
    'battlelost',
    'fled',
    'escaped',
    'ranaway',
    'runaway',
    'caught',
    'captured',
    'capturesuccess',
    'complete',
    'completed',
    'over'
  ]).has(normalized);
}

function explicitTerminalResult(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const queue = [value];
  const seen = new WeakSet();
  let inspected = 0;

  while (queue.length && inspected < 2600) {
    const current = queue.shift();
    inspected++;

    if (
      !current ||
      typeof current !== 'object' ||
      seen.has(current)
    ) {
      continue;
    }

    seen.add(current);

    for (
      const [key, item] of
      Object.entries(current).slice(0, 280)
    ) {
      const normalizedKey =
        normalizeKey(key);

      const normalizedValue =
        typeof item === 'string'
          ? normalizeKey(item)
          : '';

      // Ordered event responses may expose:
      // { t: "battle_end" }
      if (
        /^(t|event|eventtype|type|kind)$/
          .test(normalizedKey) &&
        /^(battleend|combatend|encounterend|battleover)$/
          .test(normalizedValue)
      ) {
        return true;
      }

      // Server phase is the strongest cross-battle boundary.
      if (
        /^(phase|battlephase|combatphase|encounterphase)$/
          .test(normalizedKey) &&
        /^(over|ended|complete|completed)$/
          .test(normalizedValue)
      ) {
        return true;
      }

      // Win, loss, flee and capture all finish the battle.
      if (
        /^(battleresult|combatresult|encounterresult|result|outcome)$/
          .test(normalizedKey) &&
        terminalBattleOutcome(item)
      ) {
        return true;
      }

      // Preserve earlier explicit boolean terminal flags.
      if (
        /^(escaped|fled|ranaway|runaway|capturesuccess|captured|caught|battleover|battlecomplete|combatcomplete|encountercomplete|victory|wonbattle|battlewon|defeat|lostbattle|battlelost)$/
          .test(normalizedKey) &&
        booleanLike(item)
      ) {
        return true;
      }

      if (item && typeof item === 'object') {
        queue.push(item);
      }
    }
  }

  return false;
}

function findOwnAliasEntry(object, aliases) {
  if (
    !object ||
    typeof object !== 'object' ||
    Array.isArray(object)
  ) {
    return null;
  }

  const wanted = new Set(
    aliases.map(alias => normalizeKey(alias))
  );

  for (const [key, value] of Object.entries(object)) {
    if (wanted.has(normalizeKey(key))) {
      return {
        key,
        value
      };
    }
  }

  return null;
}

function authoritativeFoeState(value) {
  if (!value || typeof value !== 'object') {
    return 'unknown';
  }

  const queue = [value];
  const seen = new WeakSet();
  let inspected = 0;
  let explicitGone = false;

  while (queue.length && inspected < 2600) {
    const current = queue.shift();
    inspected++;

    if (
      !current ||
      typeof current !== 'object' ||
      seen.has(current)
    ) {
      continue;
    }

    seen.add(current);

    const foeEntry = findOwnAliasEntry(
      current,
      ['foe', 'opponent', 'enemy']
    );

    if (foeEntry) {
      const foe = foeEntry.value;

      if (
        foe === null ||
        foe === false
      ) {
        explicitGone = true;
      } else if (
        foe &&
        typeof foe === 'object'
      ) {
        const monEntry = findOwnAliasEntry(
          foe,
          [
            'mon',
            'pokemon',
            'activePokemon',
            'active_pokemon',
            'currentPokemon',
            'current_pokemon'
          ]
        );

        if (monEntry) {
          if (
            monEntry.value &&
            typeof monEntry.value === 'object'
          ) {
            return 'active';
          }

          if (
            monEntry.value === null ||
            monEntry.value === false
          ) {
            explicitGone = true;
          }
        }
      }
    }

    for (const item of Object.values(current).slice(0, 260)) {
      if (item && typeof item === 'object') {
        queue.push(item);
      }
    }
  }

  return explicitGone ? 'gone' : 'unknown';
}

function battleEndEvidence(value) {
  if (explicitTerminalResult(value)) {
    return 'terminal';
  }

  if (authoritativeFoeState(value) === 'gone') {
    return 'foe-gone';
  }

  return null;
}

function multiplierFor(attackType, defendType) {
    return TYPE_CHART[attackType]?.[defendType] ?? 1;
  }

  function applyAbilityModifiers(multipliers, ability) {
    const normalized = normalizeKey(ability || '');

    const setZero = type => {
      multipliers[type] = 0;
    };

    const multiply = (type, amount) => {
      multipliers[type] =
        (multipliers[type] ?? 1) * amount;
    };

    if (/levitate/.test(normalized)) setZero('ground');

    if (
      /flashfire|wellbakedbody/.test(normalized)
    ) {
      setZero('fire');
    }

    if (
      /waterabsorb|stormdrain|dryskin/.test(normalized)
    ) {
      setZero('water');
    }

    if (
      /voltabsorb|lightningrod|motordrive/.test(normalized)
    ) {
      setZero('electric');
    }

    if (/sapsipper/.test(normalized)) setZero('grass');
    if (/eartheater/.test(normalized)) setZero('ground');

    if (/thickfat/.test(normalized)) {
      multiply('fire', 0.5);
      multiply('ice', 0.5);
    }

    if (/heatproof/.test(normalized)) {
      multiply('fire', 0.5);
    }

    if (/purifyingsalt/.test(normalized)) {
      multiply('ghost', 0.5);
    }

    if (/waterbubble/.test(normalized)) {
      multiply('fire', 0.5);
    }

    return multipliers;
  }

  function buildEffectiveness(types, ability) {
    if (!types.length) return null;

    const defensive = {};

    for (const attackType of TYPE_NAMES) {
      let value = 1;

      for (const defendType of types) {
        value *= multiplierFor(attackType, defendType);
      }

      defensive[attackType] = value;
    }

    applyAbilityModifiers(defensive, ability);

    const weak = [];
    const resist = [];
    const immune = [];

    for (const type of TYPE_NAMES) {
      const value = defensive[type];

      if (value === 0) {
        immune.push({ type, value });
      } else if (value > 1) {
        weak.push({ type, value });
      } else if (value < 1) {
        resist.push({ type, value });
      }
    }

    weak.sort((a, b) => b.value - a.value);
    resist.sort((a, b) => a.value - b.value);

    const strongMap = {};

    for (const targetType of TYPE_NAMES) {
      let best = 1;

      for (const attackType of types) {
        best = Math.max(
          best,
          multiplierFor(attackType, targetType)
        );
      }

      if (best > 1) strongMap[targetType] = best;
    }

    const strong = Object.entries(strongMap)
      .map(([type, value]) => ({ type, value }))
      .sort((a, b) => b.value - a.value);

    return { weak, resist, immune, strong };
  }

  function formatMultiplier(value) {
    const common = new Map([
      [4, '×4'],
      [3, '×3'],
      [2, '×2'],
      [1.5, '×1,5'],
      [1, '×1'],
      [0.75, '×¾'],
      [0.5, '×½'],
      [0.25, '×¼'],
      [0.125, '×⅛'],
      [0, '×0']
    ]);

    if (common.has(value)) return common.get(value);

    return `×${String(
      Math.round(value * 100) / 100
    ).replace('.', ',')}`;
  }

  function typeBadge(item) {
    return `
      <span
        class="ih-type-badge ih-type-${escapeHtml(item.type)}"
        title="${escapeHtml(TYPE_LABELS[item.type])}"
      >
        ${escapeHtml(TYPE_ABBR[item.type])}
        <b>${escapeHtml(formatMultiplier(item.value))}</b>
      </span>
    `;
  }

  function effectRow(label, className, items) {
    if (!items.length) {
      return `
        <div class="ih-effect-row">
          <span class="ih-effect-label ${className}">
            ${escapeHtml(label)}
          </span>
          <span class="ih-effect-none">Nenhum</span>
        </div>
      `;
    }

    return `
      <div class="ih-effect-row">
        <span class="ih-effect-label ${className}">
          ${escapeHtml(label)}
        </span>
        <div class="ih-effect-badges">
          ${items.map(typeBadge).join('')}
        </div>
      </div>
    `;
  }

  function ivClass(value) {
    if (value === 31) return 'ih-iv-perfect';
    if (value >= 25) return 'ih-iv-high';
    if (value >= 15) return 'ih-iv-mid';
    return 'ih-iv-low';
  }

  function buildIvTotal(ivs) {
    const keys = Object.keys(labels);

    if (
      !ivs ||
      !keys.every(key => Number.isFinite(ivs[key]))
    ) {
      return null;
    }

    const total = keys.reduce(
      (sum, key) => sum + ivs[key],
      0
    );

    const percentage =
      Math.round((total / 186) * 1000) / 10;

    return {
      total,
      maximum: 186,
      percentage
    };
  }

  function formatIvPercentage(value) {
    return `${String(value).replace('.', ',')}%`;
  }

  const NATURE_STAT_EFFECTS = {
    adamant: { up: 'atk', down: 'spa' },
    bold: { up: 'def', down: 'atk' },
    brave: { up: 'atk', down: 'spe' },
    calm: { up: 'spd', down: 'atk' },
    careful: { up: 'spd', down: 'spa' },
    gentle: { up: 'spd', down: 'def' },
    hasty: { up: 'spe', down: 'def' },
    impish: { up: 'def', down: 'spa' },
    jolly: { up: 'spe', down: 'spa' },
    lax: { up: 'def', down: 'spd' },
    lonely: { up: 'atk', down: 'def' },
    mild: { up: 'spa', down: 'def' },
    modest: { up: 'spa', down: 'atk' },
    naive: { up: 'spe', down: 'spd' },
    naughty: { up: 'atk', down: 'spd' },
    quiet: { up: 'spa', down: 'spe' },
    rash: { up: 'spa', down: 'spd' },
    relaxed: { up: 'def', down: 'spe' },
    sassy: { up: 'spd', down: 'spe' },
    timid: { up: 'spe', down: 'atk' }
  };

  function normalizeNatureKey(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, '');
  }

  function natureDirection(nature, stat) {
    const effect =
      NATURE_STAT_EFFECTS[
        normalizeNatureKey(nature)
      ];

    if (!effect) return null;
    if (effect.up === stat) return 'up';
    if (effect.down === stat) return 'down';
    return null;
  }

  function isPerfectIvSet(ivs) {
    return Object.keys(labels).every(
      stat => Number.isFinite(ivs?.[stat]) &&
        ivs[stat] === 31
    );
  }

  
function buildShinyEncounterAlert(
  meta,
  mode
) {
  // High-priority alert only for a catchable wild encounter.
  // NPC/trainer shinies may be visually special, but cannot be captured.
  if (
    mode !== 'wild' ||
    meta?.shiny !== true
  ) {
    return '';
  }

  return `
    <div
      class="ih-shiny-alert"
      role="alert"
      aria-live="assertive"
    >
      <span
        class="ih-shiny-alert-icon"
        aria-hidden="true"
      >✨</span>

      <div class="ih-shiny-alert-copy">
        <strong>POKÉMON SHINY ENCONTRADO!</strong>
        <small>Encontro raro — cuidado para não derrotar.</small>
      </div>

      <span
        class="ih-shiny-alert-star"
        aria-hidden="true"
      >★</span>
    </div>
  `;
}


function buildPerfectIvNotice(ivs) {
    if (!isPerfectIvSet(ivs)) return '';

    return `
      <div class="ih-perfect-pokemon" role="status">
        <span class="ih-perfect-pokemon-icon">✦</span>
        <strong>Este Pokémon é perfeito</strong>
        <span class="ih-perfect-pokemon-tag">6×31</span>
      </div>
    `;
  }

  function buildIvCards(ivs, stats, nature) {
    return Object.keys(labels)
      .map(stat => {
        const iv = ivs?.[stat];
        const current = stats?.[stat];
        const direction =
          natureDirection(nature, stat);

        const arrow = direction
          ? `
            <span
              class="ih-nature-arrow ih-nature-${direction}"
              title="Natureza ${
                direction === 'up'
                  ? 'aumenta'
                  : 'reduz'
              } este atributo"
              aria-label="Natureza ${
                direction === 'up'
                  ? 'aumenta'
                  : 'reduz'
              } este atributo"
            >${direction === 'up' ? '↑' : '↓'}</span>
          `
          : '';

        return `
          <div class="ih-iv-card">
            <span class="ih-iv-card-name">
              ${escapeHtml(labels[stat])}
            </span>

            <div class="ih-iv-card-main">
              <strong class="${
                Number.isFinite(iv)
                  ? ivClass(iv)
                  : ''
              }">
                ${iv ?? '—'}
              </strong>
              ${arrow}
            </div>

            <small class="ih-iv-card-current">
              ${
                Number.isFinite(current)
                  ? `STAT ${current}`
                  : 'STAT —'
              }
            </small>
          </div>
        `;
      })
      .join('');
  }


const TEAM_POSITIVE_CONTEXT =
  /(?:^|[._\[\]-])(party|team|lineup|squad|roster|playerparty|playerteam|myteam|yourteam|activeteam)(?:[._\[\]-]|$)/i;

const TEAM_NEGATIVE_CONTEXT =
  /(?:^|[._\[\]-])(pcjson|storage|stored|box|boxes|collection|owned|pokedex|opponent|enemy|foe|trainer|npc|rival|leader|boss)(?:[._\[\]-]|$)/i;

function readTeamNamedValue(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  for (const key of [
    'name',
    'displayName',
    'display_name',
    'identifier',
    'label',
    'title'
  ]) {
    if (typeof value[key] === 'string') {
      return value[key];
    }
  }

  return null;
}

function playerTeamPokemonObject(entry) {
  if (!entry || typeof entry !== 'object') {
    return entry;
  }

  const nested =
    getByAliases(entry, [
      'pokemon',
      'mon',
      'member',
      'creature',
      'activePokemon',
      'active_pokemon',
      'currentPokemon',
      'current_pokemon',
      'playerPokemon',
      'player_pokemon',
      'activeBattler',
      'active_battler',
      'battler',
      'leadPokemon',
      'lead_pokemon'
    ]);

  if (
    nested &&
    typeof nested === 'object'
  ) {
    return {
      ...entry,
      ...nested
    };
  }

  return entry;
}

function extractPlayerTeamHp(object, stats) {
  const current =
    numberInRange(
      getByAliases(object, [
        'currentHp',
        'current_hp',
        'hpCurrent',
        'hp_current',
        'remainingHp',
        'remaining_hp',
        'battleHp',
        'battle_hp'
      ]),
      0,
      99999
    );

  const maximum =
    numberInRange(
      getByAliases(object, [
        'maxHp',
        'max_hp',
        'hpMax',
        'hp_max',
        'maximumHp',
        'maximum_hp'
      ]),
      1,
      99999
    ) ??
    numberInRange(stats?.hp, 1, 99999);

  const directHp =
    numberInRange(
      getByAliases(object, [
        'hp',
        'health'
      ]),
      0,
      99999
    );

  const resolvedCurrent =
    current ??
    (
      maximum !== null &&
      directHp !== null &&
      directHp <= maximum
        ? directHp
        : null
    );

  return {
    current: resolvedCurrent,
    maximum
  };
}


function moveDatabaseEntry(name) {
  if (!name) return null;

  const entry =
    MoveData.byName[normalizeKey(name)];

  if (!entry) return null;

  return {
    identifier: entry[0],
    type: entry[1],
    power:
      Number.isFinite(Number(entry[2]))
        ? Number(entry[2])
        : null,
    damageClass: entry[3] || 'status',
    accuracy:
      Number.isFinite(Number(entry[4]))
        ? Number(entry[4])
        : null
  };
}

function extractTeamMoveRecord(value) {
  if (value == null) return null;

  let object =
    value && typeof value === 'object'
      ? value
      : null;

  const nested =
    object
      ? getByAliases(object, [
          'move',
          'attack',
          'skill',
          'technique'
        ])
      : null;

  if (
    nested &&
    typeof nested === 'object'
  ) {
    object = {
      ...object,
      ...nested
    };
  }

  const name =
    typeof value === 'string'
      ? value
      : (
          readTeamNamedValue(
            getByAliases(object, [
              'moveName',
              'move_name',
              'attackName',
              'attack_name',
              'skillName',
              'skill_name',
              'name',
              'move',
              'attack',
              'skill'
            ])
          ) ||
          readTeamNamedValue(object)
        );

  if (!name) return null;

  const fallback =
    moveDatabaseEntry(name);

  const type =
    normalizeType(
      getByAliases(object, [
        'type',
        'moveType',
        'move_type',
        'attackType',
        'attack_type'
      ])
    ) ||
    fallback?.type ||
    null;

  const power =
    numberInRange(
      getByAliases(object, [
        'power',
        'basePower',
        'base_power'
      ]),
      0,
      999
    ) ??
    fallback?.power ??
    null;

  let damageClass =
    readTeamNamedValue(
      getByAliases(object, [
        'damageClass',
        'damage_class',
        'category',
        'class'
      ])
    );

  damageClass =
    normalizeKey(
      damageClass ||
      fallback?.damageClass ||
      ''
    );

  if (
    damageClass === 'physical' ||
    damageClass === 'fisico'
  ) {
    damageClass = 'physical';
  } else if (
    damageClass === 'special' ||
    damageClass === 'especial'
  ) {
    damageClass = 'special';
  } else if (
    damageClass === 'status' ||
    power === 0 ||
    power == null
  ) {
    damageClass = 'status';
  } else {
    damageClass =
      fallback?.damageClass ||
      'physical';
  }

  const currentPp =
    numberInRange(
      getByAliases(object, [
        'currentPp',
        'current_pp',
        'ppCurrent',
        'pp_current',
        'remainingPp',
        'remaining_pp'
      ]),
      0,
      99
    );

  return {
    name,
    identifier:
      fallback?.identifier ||
      normalizeKey(name),
    type,
    power,
    damageClass,
    currentPp
  };
}

function extractTeamMoves(object) {
  if (!object || typeof object !== 'object') {
    return [];
  }

  const candidates = [];
  const direct = getByAliases(object, [
    'moves',
    'moveSet',
    'moveset',
    'moveSlots',
    'move_slots',
    'attacks',
    'skills',
    'techniques'
  ]);

  if (Array.isArray(direct)) {
    candidates.push(...direct);
  } else if (
    direct &&
    typeof direct === 'object'
  ) {
    candidates.push(...Object.values(direct));
  }

  const queue = [{
    value: object,
    depth: 0
  }];

  const seen = new WeakSet();

  while (queue.length) {
    const current = queue.shift();

    if (
      !current.value ||
      typeof current.value !== 'object' ||
      seen.has(current.value) ||
      current.depth > 3
    ) {
      continue;
    }

    seen.add(current.value);

    for (
      const [key, item] of
      Object.entries(current.value).slice(0, 180)
    ) {
      if (
        /moves?|moveset|move.?slots?|attacks?|skills?|techniques?/i
          .test(key)
      ) {
        if (Array.isArray(item)) {
          candidates.push(...item);
        } else if (
          item &&
          typeof item === 'object'
        ) {
          candidates.push(...Object.values(item));
        }
      }

      if (
        item &&
        typeof item === 'object'
      ) {
        queue.push({
          value: item,
          depth: current.depth + 1
        });
      }
    }
  }

  const output = [];
  const used = new Set();

  for (const candidate of candidates) {
    const move =
      extractTeamMoveRecord(candidate);

    if (!move) continue;

    const key = normalizeKey(
      move.identifier ||
      move.name
    );

    if (!key || used.has(key)) {
      continue;
    }

    used.add(key);
    output.push(move);

    if (output.length >= 4) break;
  }

  return output;
}

function mergeTeamMoveLists(
  previous,
  next
) {
  const map = new Map();

  for (const move of [
    ...(previous || []),
    ...(next || [])
  ]) {
    const key = normalizeKey(
      move.identifier ||
      move.name
    );

    if (!key) continue;

    const existing = map.get(key);

    map.set(
      key,
      existing
        ? {
            ...existing,
            ...move,
            type:
              move.type ||
              existing.type,
            power:
              move.power ??
              existing.power ??
              null,
            damageClass:
              move.damageClass ||
              existing.damageClass,
            currentPp:
              move.currentPp ??
              existing.currentPp ??
              null
          }
        : move
    );
  }

  return [...map.values()].slice(0, 4);
}


// A complete move list received from InfinityMMO is a current snapshot,
// not historical data. It must replace the previous set instead of being
// appended after four cached moves, which could discard a newly learned move.
function withAuthoritativeTeamMoves(
  member,
  moves
) {
  if (
    !member ||
    !Array.isArray(moves) ||
    !moves.length
  ) {
    return member;
  }

  const exact = moves
    .filter(move =>
      move &&
      typeof move === 'object' &&
      (
        move.name ||
        move.identifier
      )
    )
    .slice(0, 4);

  if (!exact.length) {
    return member;
  }

  return {
    ...member,
    moves: exact
  };
}


const PLAYER_MOVE_POSITIVE_CONTEXT =
  /(?:^|[._\[\]-])(player|self|mine|my|ally|you|your|party|team|lineup|squad|roster|playerparty|playerteam|myteam|activeteam)(?:[._\[\]-]|$)/i;

const PLAYER_MOVE_NEGATIVE_CONTEXT =
  /(?:^|[._\[\]-])(opponent|enemy|foe|trainer|npc|rival|leader|boss|pcjson|storage|stored|box|boxes|collection|owned|pokedex)(?:[._\[\]-]|$)/i;

function cacheSafeMove(move) {
  if (!move?.name) return null;

  return {
    name: String(move.name),
    identifier:
      move.identifier
        ? String(move.identifier)
        : normalizeKey(move.name),
    type: move.type || null,
    power:
      Number.isFinite(move.power)
        ? move.power
        : null,
    damageClass:
      move.damageClass || 'status',
    accuracy:
      Number.isFinite(move.accuracy)
        ? move.accuracy
        : null,
    currentPp: null
  };
}

function sanitizeMoveCache(raw) {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const output = {};
  const entries = Object.entries(raw)
    .slice(-120);

  for (const [key, value] of entries) {
    if (
      typeof key !== 'string' ||
      !value ||
      typeof value !== 'object' ||
      !Array.isArray(value.moves)
    ) {
      continue;
    }

    const moves = value.moves
      .map(cacheSafeMove)
      .filter(Boolean)
      .slice(0, 4);

    if (!moves.length) continue;

    output[key] = {
      moves,
      updatedAt:
        Number.isFinite(value.updatedAt)
          ? value.updatedAt
          : Date.now()
    };
  }

  return output;
}

function playerMoveCachePrimaryKey(member) {
  const name = normalizeKey(member?.name || '');

  if (!name) return null;

  const level =
    Number.isFinite(member.level)
      ? member.level
      : 'x';

  const order =
    Number.isFinite(member.order)
      ? member.order
      : 'x';

  return `${name}|${level}|${order}`;
}

function playerMoveCacheSpeciesKey(member) {
  const name = normalizeKey(member?.name || '');

  if (!name) return null;

  const level =
    Number.isFinite(member.level)
      ? member.level
      : 'x';

  return `${name}|${level}`;
}

function cachedMovesForMember(member) {
  const primary =
    playerMoveCachePrimaryKey(member);

  const species =
    playerMoveCacheSpeciesKey(member);

  const direct =
    (
      primary &&
      playerMoveCache[primary]
    ) ||
    (
      species &&
      playerMoveCache[species]
    );

  if (direct?.moves?.length) {
    return direct.moves;
  }

  // Fallback by species only when there is exactly one matching cache.
  const namePrefix =
    `${normalizeKey(member?.name || '')}|`;

  if (namePrefix === '|') {
    return [];
  }

  const matches = Object.entries(playerMoveCache)
    .filter(([key, value]) =>
      key.startsWith(namePrefix) &&
      value?.moves?.length
    );

  if (matches.length === 1) {
    return matches[0][1].moves;
  }

  return [];
}

function hydrateMemberMovesFromCache(member) {
  if (!member) return member;

  const cached =
    cachedMovesForMember(member);

  if (!cached.length) {
    return member;
  }

  return {
    ...member,
    moves: mergeTeamMoveLists(
      cached,
      member.moves
    )
  };
}

function scheduleMoveCacheSave() {
  if (moveCacheSaveTimer) {
    clearTimeout(moveCacheSaveTimer);
  }

  moveCacheSaveTimer = setTimeout(() => {
    moveCacheSaveTimer = null;

    chrome.storage.local.set({
      [MOVE_CACHE_STORAGE_KEY]:
        playerMoveCache
    });
  }, 180);
}

function rememberMemberMoves(member) {
  if (!member?.moves?.length) {
    return false;
  }

  const safeMoves = member.moves
    .map(cacheSafeMove)
    .filter(Boolean)
    .slice(0, 4);

  if (!safeMoves.length) {
    return false;
  }

  const primary =
    playerMoveCachePrimaryKey(member);

  const species =
    playerMoveCacheSpeciesKey(member);

  const keys = [
    primary,
    species
  ].filter(Boolean);

  let changed = false;

  for (const key of keys) {
    const previous =
      playerMoveCache[key]?.moves || [];

    const nextSignature = safeMoves
      .map(move =>
        [
          normalizeKey(
            move.identifier ||
            move.name
          ),
          move.type || '',
          move.power ?? '',
          move.damageClass || ''
        ].join(':')
      )
      .join('|');

    const previousSignature = previous
      .map(move =>
        [
          normalizeKey(
            move.identifier ||
            move.name
          ),
          move.type || '',
          move.power ?? '',
          move.damageClass || ''
        ].join(':')
      )
      .join('|');

    if (nextSignature === previousSignature) {
      continue;
    }

    playerMoveCache[key] = {
      moves: safeMoves,
      updatedAt: Date.now()
    };

    changed = true;
  }

  if (changed) {
    scheduleMoveCacheSave();
  }

  return changed;
}

function rememberTeamMoves(team) {
  let changed = false;

  for (const member of team || []) {
    if (rememberMemberMoves(member)) {
      changed = true;
    }
  }

  return changed;
}

function hydratePlayerTeamFromMoveCache() {
  if (!playerTeam.length) {
    return false;
  }

  const before = teamSignature(playerTeam);

  playerTeam = playerTeam.map(
    hydrateMemberMovesFromCache
  );

  return (
    teamSignature(playerTeam) !==
    before
  );
}


function knownTeamMoveCount() {
  return playerTeam.reduce(
    (sum, member) =>
      sum + (member.moves?.length || 0),
    0
  );
}

function dispatchMoveRescanRequest(
  reason = 'missing-moves'
) {
  const now = Date.now();

  if (now - lastMoveRescanAt < 120) {
    return;
  }

  lastMoveRescanAt = now;

  window.dispatchEvent(
    new CustomEvent(
      MOVE_RESCAN_EVENT_NAME,
      {
        detail: {
          reason,
          timestamp: now
        }
      }
    )
  );
}

function stopMoveRescanLoop() {
  if (moveRescanTimer) {
    clearTimeout(moveRescanTimer);
    moveRescanTimer = null;
  }

  moveRescanAttempt = 0;
}

function scheduleMoveRescanLoop(
  reason = 'missing-moves'
) {
  if (
    !activeEncounter ||
    knownTeamMoveCount() > 0
  ) {
    stopMoveRescanLoop();
    return;
  }

  dispatchMoveRescanRequest(reason);

  const delays = [
    80,
    180,
    350,
    650,
    1100,
    1800,
    2800,
    4200,
    6500
  ];

  const delay =
    delays[
      Math.min(
        moveRescanAttempt,
        delays.length - 1
      )
    ];

  moveRescanAttempt++;

  if (moveRescanTimer) {
    clearTimeout(moveRescanTimer);
  }

  moveRescanTimer = setTimeout(() => {
    moveRescanTimer = null;

    if (
      activeEncounter &&
      knownTeamMoveCount() === 0
    ) {
      scheduleMoveRescanLoop(reason);
    } else {
      stopMoveRescanLoop();
    }
  }, delay);
}

function readStorageDirectlyForMoves() {
  let changed = false;

  const sensitiveStorageKey =
    /password|passwd|senha|token|authorization|cookie|secret|email|username|login|refresh.?token|access.?token/i;

  for (const [store, source] of [
    [
      window.localStorage,
      'direct-localStorage'
    ],
    [
      window.sessionStorage,
      'direct-sessionStorage'
    ]
  ]) {
    try {
      for (
        let i = 0;
        i < Math.min(store.length, 300);
        i++
      ) {
        const key = store.key(i);

        if (
          !key ||
          sensitiveStorageKey.test(key)
        ) {
          continue;
        }

        const raw =
          store.getItem(key);

        if (
          typeof raw !== 'string' ||
          !raw ||
          raw.length > 900000
        ) {
          continue;
        }

        let value = null;

        try {
          value = JSON.parse(raw);
        } catch (_) {
          continue;
        }

        const detail = {
          source,
          timestamp: Date.now(),
          meta: {
            storageKey: key
          },
          value
        };

        if (
          cacheOwnedPokemonDetails(
            value,
            detail
          )
        ) {
          changed = true;
        }

        if (
          capturePlayerMovesFromPayload(
            value,
            detail
          )
        ) {
          changed = true;
        }

        if (
          updatePlayerTeam(
            value,
            detail
          )
        ) {
          changed = true;
        }
      }
    } catch (_) {}
  }

  if (changed && activeEncounter) {
    refreshTypeRecommendation();
  }

  return changed;
}

function capturePlayerMovesFromPayload(
  root,
  detail
) {
  if (!root || typeof root !== 'object') {
    return false;
  }

  const queue = [{
    value: root,
    path: '$'
  }];

  const seen = new WeakSet();
  let inspected = 0;
  let changed = false;

  while (queue.length && inspected < 6500) {
    const current = queue.shift();
    inspected++;

    if (
      !current.value ||
      typeof current.value !== 'object' ||
      seen.has(current.value)
    ) {
      continue;
    }

    seen.add(current.value);

    const context = [
      current.path,
      detail?.source,
      detail?.meta?.url
    ]
      .filter(Boolean)
      .join(' ');

    if (
      PLAYER_MOVE_POSITIVE_CONTEXT.test(context) &&
      !PLAYER_MOVE_NEGATIVE_CONTEXT.test(context) &&
      !Array.isArray(current.value)
    ) {
      const object =
        playerTeamPokemonObject(
          current.value
        );

      const meta = withNpcTypeFallback(
        extractMeta(object),
        object
      );

      const moves =
        extractTeamMoves(object);

      if (
        meta.name &&
        moves.length
      ) {
        const existingIndex =
          playerTeam.findIndex(member =>
            normalizeKey(member.name) ===
            normalizeKey(meta.name) &&
            (
              !Number.isFinite(meta.level) ||
              !Number.isFinite(member.level) ||
              member.level === meta.level
            )
          );

        const directStats =
          extractStats(object);

        const heldItemState =
          extractHeldItemState(object);

        const temporary = {
          name: meta.name,
          level: meta.level,
          types: meta.types || [],
          ability: meta.ability || null,
          heldItem:
            heldItemState.value,
          heldItemObserved:
            heldItemState.observed,
          stats: directStats,
          moves,
          hp: extractPlayerTeamHp(
            object,
            directStats
          ),
          status:
            readTeamNamedValue(
              getByAliases(object, [
                'status',
                'condition',
                'battleStatus',
                'battle_status'
              ])
            ),
          active:
            hasExplicitActivePlayerFlag(object),
          fainted: false,
          order:
            existingIndex >= 0
              ? playerTeam[existingIndex].order
              : null,
          path: current.path,
          source: detail?.source || 'jogo',
          updatedAt: Date.now()
        };

        temporary.fainted =
          temporary.hp.current === 0 ||
          /fainted|desmaiado|derrotado/i
            .test(String(temporary.status || ''));

        if (rememberMemberMoves(temporary)) {
          changed = true;
        }

        if (existingIndex >= 0) {
          const previousSignature =
            teamSignature([
              playerTeam[existingIndex]
            ]);

          const mergedMember =
            mergeTeamMember(
              playerTeam[existingIndex],
              temporary
            );

          const characterSnapshot =
            /\/api\/character(?:\/(?:save|party))?(?:[?#]|$)/i
              .test(
                String(
                  detail?.meta?.url || ''
                )
              );

          playerTeam[existingIndex] =
            characterSnapshot &&
            temporary.moves?.length
              ? withAuthoritativeTeamMoves(
                  mergedMember,
                  temporary.moves
                )
              : mergedMember;

          const nextSignature =
            teamSignature([
              playerTeam[existingIndex]
            ]);

          if (
            previousSignature !==
            nextSignature
          ) {
            changed = true;
          }
        }
      }
    }

    if (Array.isArray(current.value)) {
      current.value
        .slice(0, 500)
        .forEach((item, index) => {
          if (item && typeof item === 'object') {
            queue.push({
              value: item,
              path: `${current.path}[${index}]`
            });
          }
        });
    } else {
      Object.entries(current.value)
        .slice(0, 650)
        .forEach(([key, item]) => {
          if (item && typeof item === 'object') {
            queue.push({
              value: item,
              path: `${current.path}.${key}`
            });
          }
        });
    }
  }

  return changed;
}


function explicitBooleanTrue(value) {
  if (
    value === true ||
    value === 1 ||
    value === '1'
  ) {
    return true;
  }

  if (typeof value !== 'string') {
    return false;
  }

  return /^(true|yes|active|current|battle|battling|inbattle|lead)$/i
    .test(value.trim());
}

function hasExplicitActivePlayerFlag(object) {
  if (!object || typeof object !== 'object') {
    return false;
  }

  for (const alias of [
    'isActive',
    'is_active',
    'active',
    'isCurrent',
    'is_current',
    'current',
    'inBattle',
    'in_battle',
    'isInBattle',
    'is_in_battle',
    'battling',
    'isBattling',
    'is_battling',
    'activeBattler',
    'active_battler',
    'isLead',
    'is_lead',
    'lead'
  ]) {
    if (
      explicitBooleanTrue(
        getByAliases(object, [alias])
      )
    ) {
      return true;
    }
  }

  return false;
}

function buildPlayerTeamMember(
  entry,
  path,
  detail,
  order
) {
  const object =
    playerTeamPokemonObject(entry);

  if (!object || typeof object !== 'object') {
    return null;
  }

  const meta = withNpcTypeFallback(
    extractMeta(object),
    object
  );

  if (!meta.name) {
    return null;
  }

  const stats = extractStats(object);
  const hp = extractPlayerTeamHp(
    object,
    stats
  );

  const status =
    readTeamNamedValue(
      getByAliases(object, [
        'status',
        'condition',
        'battleStatus',
        'battle_status'
      ])
    );

  const rawShiny = getByAliases(object, [
    'shiny',
    'isShiny',
    'is_shiny'
  ]);

  const gender = readTeamNamedValue(
    getByAliases(object, [
      'gender',
      'sex'
    ])
  );

  const heldItemState =
    extractHeldItemState(object);

  const pokemonId = numberInRange(
    getByAliases(object, [
      'id',
      'pokemonId',
      'pokemon_id',
      'monId',
      'mon_id'
    ]),
    1,
    999999999
  );

  return hydrateMemberMovesFromCache({
    id: pokemonId,
    name: meta.name,
    species: normalizeKey(
      getByAliases(object, ['species']) ||
      meta.name
    ),
    level: meta.level,
    nature: meta.nature || null,
    gender: gender || null,
    shiny:
      rawShiny == null
        ? null
        : booleanLike(rawShiny),
    types: meta.types || [],
    ability: meta.ability || null,
    heldItem:
      heldItemState.value,
    heldItemObserved:
      heldItemState.observed,
    stats,
    moves: extractTeamMoves(object),
    hp,
    status,
    active:
      hasExplicitActivePlayerFlag(object) ||
      hasExplicitActivePlayerFlag(entry),
    fainted:
      hp.current === 0 ||
      /fainted|desmaiado|derrotado/i
        .test(String(status || '')),
    path,
    order,
    source: detail?.source || 'jogo',
    updatedAt: Date.now()
  });
}

function teamMemberQuality(member) {
  if (!member) return 0;

  let score = 0;

  score += member.types.length * 35;
  score += member.moves.length * 18;
  score += Object.keys(member.stats || {}).length * 4;

  if (member.ability) score += 6;
  if (member.heldItemObserved) score += 3;
  if (member.active) score += 4;
  if (member.level) score += 5;
  if (member.hp.current !== null) score += 5;
  if (member.hp.maximum !== null) score += 5;

  return score;
}

function mergeTeamMember(
  previous,
  next
) {
  if (!previous) return next;

  if (
    normalizeKey(previous.name) !==
    normalizeKey(next.name)
  ) {
    return next;
  }

  if (
    Number.isFinite(previous.level) &&
    Number.isFinite(next.level) &&
    previous.level !== next.level
  ) {
    return next;
  }

  return {
    ...previous,
    ...next,
    level:
      next.level ??
      previous.level ??
      null,
    types:
      next.types?.length
        ? next.types
        : previous.types,
    ability:
      next.ability ||
      previous.ability ||
      null,
    heldItem:
      next.heldItemObserved === true
        ? next.heldItem
        : (
            previous.heldItem ??
            null
          ),
    heldItemObserved:
      next.heldItemObserved === true ||
      previous.heldItemObserved === true,
    stats: {
      ...(previous.stats || {}),
      ...(next.stats || {})
    },
    moves: mergeTeamMoveLists(
      previous.moves,
      next.moves
    ),
    hp: {
      current:
        next.hp.current ??
        previous.hp.current ??
        null,
      maximum:
        next.hp.maximum ??
        previous.hp.maximum ??
        null
    },
    status:
      next.status ||
      previous.status ||
      null,
    active:
      next.active === true ||
      (
        next.active !== false &&
        previous.active === true
      ),
    fainted:
      next.fainted ||
      (
        next.hp.current === null &&
        previous.fainted
      )
  };
}


function parseOwnedPokemonCollection(value) {
  if (typeof value !== 'string') {
    return value;
  }

  if (
    !value.trim() ||
    value.length > 2500000
  ) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function ownedPokemonMoveKeys(member) {
  return new Set(
    (member?.moves || [])
      .map(move =>
        normalizeKey(
          move?.identifier ||
          move?.name ||
          ''
        )
      )
      .filter(Boolean)
  );
}

function ownedPokemonCacheKey(member) {
  if (!member?.name) return null;

  if (Number.isFinite(member.id)) {
    return `id:${member.id}`;
  }

  return [
    normalizeKey(member.name),
    member.level ?? '',
    member.hp?.maximum ?? '',
    member.gender || '',
    member.shiny == null
      ? ''
      : (member.shiny ? '1' : '0'),
    [...ownedPokemonMoveKeys(member)]
      .sort()
      .join(',')
  ].join('|');
}

function memberHasUsefulBattleStats(member) {
  return Boolean(
    member &&
    (
      numberInRange(member.stats?.atk, 1, 99999) !== null ||
      numberInRange(member.stats?.spa, 1, 99999) !== null
    )
  );
}

function cacheOwnedPokemonMember(member) {
  if (
    !member?.name ||
    !memberHasUsefulBattleStats(member)
  ) {
    return false;
  }

  const key = ownedPokemonCacheKey(member);

  if (!key) return false;

  const index = playerPokemonDetailCache.findIndex(
    entry => entry.key === key
  );

  const previous =
    index >= 0
      ? playerPokemonDetailCache[index].member
      : null;

  let next = previous
    ? mergeTeamMember(previous, member)
    : member;

  // /api/character and /api/character/save return the Pokémon's complete
  // current move set. Preserve old stats if needed, but replace old moves.
  if (member.moves?.length) {
    next = withAuthoritativeTeamMoves(
      next,
      member.moves
    );
  }

  const previousSignature = previous
    ? activePlayerSignature(previous)
    : '';

  const nextSignature =
    activePlayerSignature(next);

  const record = {
    key,
    member: next,
    updatedAt: Date.now()
  };

  if (index >= 0) {
    playerPokemonDetailCache[index] = record;
  } else {
    playerPokemonDetailCache.push(record);
  }

  if (
    playerPokemonDetailCache.length >
    PLAYER_POKEMON_DETAIL_CACHE_LIMIT
  ) {
    playerPokemonDetailCache =
      playerPokemonDetailCache
        .sort((a, b) =>
          a.updatedAt - b.updatedAt
        )
        .slice(
          -PLAYER_POKEMON_DETAIL_CACHE_LIMIT
        );
  }

  return previousSignature !== nextSignature;
}

function addOwnedPokemonArray(
  value,
  path,
  detail,
  output
) {
  const collection =
    parseOwnedPokemonCollection(value);

  if (!Array.isArray(collection)) {
    return;
  }

  collection
    .slice(0, 1500)
    .forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }

      const nestedPokemon =
        parseOwnedPokemonCollection(
          getByAliases(entry, [
            'pokemon',
            'pokemons',
            'mons',
            'members'
          ])
        );

      if (Array.isArray(nestedPokemon)) {
        nestedPokemon
          .slice(0, 500)
          .forEach((pokemon, pokemonIndex) => {
            const member = buildPlayerTeamMember(
              pokemon,
              `${path}[${index}].pokemon[${pokemonIndex}]`,
              detail,
              -1
            );

            if (member?.name) {
              output.push(member);
            }
          });

        return;
      }

      const member = buildPlayerTeamMember(
        entry,
        `${path}[${index}]`,
        detail,
        index
      );

      if (member?.name) {
        output.push(member);
      }
    });
}

function cacheOwnedPokemonDetails(
  root,
  detail
) {
  if (!root || typeof root !== 'object') {
    return false;
  }

  const url = String(
    detail?.meta?.url || ''
  );

  // Only the player's own character endpoints may seed this cache.
  // Battle foe parties and generic payloads are intentionally ignored.
  if (
    !/\/api\/character(?:\/(?:save|party))?(?:[?#]|$)/i
      .test(url)
  ) {
    return false;
  }

  const members = [];

  addOwnedPokemonArray(
    getByAliases(root, [
      'party_json',
      'partyJson',
      'party'
    ]),
    '$.party',
    detail,
    members
  );

  addOwnedPokemonArray(
    getByAliases(root, [
      'pc_json',
      'pcJson',
      'pc'
    ]),
    '$.pc',
    detail,
    members
  );

  let changed = false;

  for (const member of members) {
    if (cacheOwnedPokemonMember(member)) {
      changed = true;
    }
  }

  return changed;
}

function ownedPokemonDetailMatchScore(
  cached,
  member
) {
  if (
    !cached?.name ||
    !member?.name ||
    normalizeKey(cached.name) !==
      normalizeKey(member.name)
  ) {
    return null;
  }

  let score = 20;

  if (
    Number.isFinite(cached.id) &&
    Number.isFinite(member.id)
  ) {
    if (cached.id !== member.id) {
      return null;
    }

    score += 120;
  }

  if (
    Number.isFinite(cached.level) &&
    Number.isFinite(member.level)
  ) {
    if (cached.level !== member.level) {
      return null;
    }

    score += 25;
  }

  const cachedMax = numberInRange(
    cached.hp?.maximum,
    1,
    99999
  );

  const memberMax = numberInRange(
    member.hp?.maximum,
    1,
    99999
  );

  if (
    cachedMax !== null &&
    memberMax !== null
  ) {
    if (cachedMax !== memberMax) {
      return null;
    }

    score += 25;
  }

  if (cached.gender && member.gender) {
    if (
      normalizeKey(cached.gender) !==
      normalizeKey(member.gender)
    ) {
      return null;
    }

    score += 8;
  }

  if (
    cached.shiny != null &&
    member.shiny != null
  ) {
    if (cached.shiny !== member.shiny) {
      return null;
    }

    score += 8;
  }

  const cachedMoves =
    ownedPokemonMoveKeys(cached);

  const memberMoves =
    ownedPokemonMoveKeys(member);

  let overlap = 0;

  for (const key of memberMoves) {
    if (cachedMoves.has(key)) {
      overlap += 1;
    }
  }

  score += overlap * 10;

  if (
    memberMoves.size > 0 &&
    overlap === memberMoves.size
  ) {
    score += 20;
  }

  if (memberHasUsefulBattleStats(cached)) {
    score += 10;
  }

  return score;
}

function findOwnedPokemonDetail(member) {
  const ranked = playerPokemonDetailCache
    .map(entry => ({
      entry,
      score: ownedPokemonDetailMatchScore(
        entry.member,
        member
      )
    }))
    .filter(item =>
      item.score !== null &&
      item.score >= 70
    )
    .sort((a, b) =>
      b.score - a.score ||
      b.entry.updatedAt -
        a.entry.updatedAt
    );

  if (!ranked.length) {
    return null;
  }

  if (
    ranked.length > 1 &&
    ranked[0].score === ranked[1].score &&
    ranked[0].entry.key !==
      ranked[1].entry.key
  ) {
    // Two indistinguishable owned Pokémon: do not guess stats.
    return null;
  }

  return ranked[0].entry.member;
}

function hydrateMemberDetailsFromCache(member) {
  if (!member?.name) return member;

  const cached =
    findOwnedPokemonDetail(member);

  return cached
    ? mergeTeamMember(cached, member)
    : member;
}

function refreshOwnedPokemonDetailHydration() {
  let changed = false;

  const previousTeamSignature =
    teamSignature(playerTeam);

  playerTeam = playerTeam.map(
    hydrateMemberDetailsFromCache
  );

  if (
    teamSignature(playerTeam) !==
    previousTeamSignature
  ) {
    changed = true;
  }

  if (activePlayerPokemon) {
    const hydrated =
      hydrateMemberDetailsFromCache(
        activePlayerPokemon
      );

    if (
      activePlayerSignature(hydrated) !==
      activePlayerSignature(
        activePlayerPokemon
      )
    ) {
      activePlayerPokemon = hydrated;
      activePlayerPokemonUpdatedAt =
        Date.now();
      changed = true;
    }
  }

  if (activePlayerSwitchEventPokemon) {
    const hydratedSwitch =
      hydrateMemberDetailsFromCache(
        activePlayerSwitchEventPokemon
      );

    if (
      activePlayerSignature(hydratedSwitch) !==
      activePlayerSignature(
        activePlayerSwitchEventPokemon
      )
    ) {
      activePlayerSwitchEventPokemon =
        hydratedSwitch;
      activePlayerSwitchEventUpdatedAt =
        Date.now();
      changed = true;
    }
  }

  return changed;
}

function teamContextText(path, detail) {
  return [
    path,
    detail?.source,
    detail?.meta?.url,
    detail?.meta?.key,
    detail?.meta?.storageKey
  ]
    .filter(Boolean)
    .join(' ');
}


const TRUSTED_BATTLE_PLAYER_TEAM_PATH =
  /^(?:\$\.you|\$\.state\.you\.party)$/i;

const TRUSTED_EXPLICIT_PLAYER_TEAM_PATH =
  /(?:^|[.\[\]_-])(party[_-]?json|playerparty|playerteam|myteam|yourteam|activeteam)(?:[.\[\]_-]|$)/i;

const UNTRUSTED_MULTIPLAYER_COLLECTION =
  /(?:^|[.\[\]_-])(players|otherplayers|nearbyplayers|onlineplayers|visibleplayers|entities|avatars|sessions|spectators)(?:[.\[\]_-]|$)/i;

function trustedPlayerTeamArrayContext(
  path,
  detail
) {
  const context =
    teamContextText(path, detail);

  const url = String(
    detail?.meta?.url || ''
  );

  const source = normalizeKey(
    detail?.source || ''
  );

  const structuralContext = [
    path,
    url,
    detail?.meta?.key,
    detail?.meta?.storageKey
  ]
    .filter(Boolean)
    .join(' ');

  if (
    TEAM_NEGATIVE_CONTEXT.test(structuralContext) ||
    UNTRUSTED_MULTIPLAYER_COLLECTION.test(structuralContext)
  ) {
    return false;
  }

  if (
    /\/api\/battle\/v2\/(?:start|action|replace|optional-switch)(?:[?#]|$)/i
      .test(url)
  ) {
    return TRUSTED_BATTLE_PLAYER_TEAM_PATH
      .test(path);
  }

  if (
    /\/api\/character(?:\/(?:save|party))?(?:[?#]|$)/i
      .test(url)
  ) {
    return (
      TRUSTED_EXPLICIT_PLAYER_TEAM_PATH
        .test(path) ||
      /^(?:\$\.party|\$\.party_json|\$\.partyJson)$/i
        .test(path)
    );
  }

  if (
    source === 'localstorage' ||
    source === 'sessionstorage' ||
    source === 'jsonparse'
  ) {
    const storageKey = String(
      detail?.meta?.key ||
      detail?.meta?.storageKey ||
      ''
    );

    return (
      TRUSTED_EXPLICIT_PLAYER_TEAM_PATH
        .test(path) ||
      TRUSTED_EXPLICIT_PLAYER_TEAM_PATH
        .test(storageKey)
    );
  }

  // Generic payloads must name the collection explicitly as player-owned.
  return TRUSTED_EXPLICIT_PLAYER_TEAM_PATH
    .test(path);
}

function scoreTeamArray(
  array,
  path,
  detail
) {
  if (
    !Array.isArray(array) ||
    array.length < 1 ||
    array.length > 6
  ) {
    return null;
  }

  const context =
    teamContextText(path, detail);

  if (
    !trustedPlayerTeamArrayContext(
      path,
      detail
    )
  ) {
    return null;
  }

  const members = array
    .map((entry, index) =>
      buildPlayerTeamMember(
        entry,
        `${path}[${index}]`,
        detail,
        index
      )
    )
    .filter(Boolean);

  if (!members.length) {
    return null;
  }

  let score = members.length * 25;

  if (TEAM_POSITIVE_CONTEXT.test(context)) {
    score += 110;
  }

  if (
    /player|self|mine|my|ally|your/i
      .test(context)
  ) {
    score += 60;
  }

  score += members.reduce(
    (sum, member) =>
      sum + teamMemberQuality(member),
    0
  );

  if (members.length === array.length) {
    score += 30;
  }

  return {
    members,
    path,
    score
  };
}

function findBestPlayerTeam(root, detail) {
  if (!root || typeof root !== 'object') {
    return null;
  }

  const queue = [{
    value: root,
    path: '$'
  }];

  const seen = new WeakSet();
  let best = null;
  let inspected = 0;

  while (queue.length && inspected < 9000) {
    const current = queue.shift();
    inspected++;

    if (
      !current.value ||
      typeof current.value !== 'object' ||
      seen.has(current.value)
    ) {
      continue;
    }

    seen.add(current.value);

    if (Array.isArray(current.value)) {
      const candidate = scoreTeamArray(
        current.value,
        current.path,
        detail
      );

      if (
        candidate &&
        (
          !best ||
          candidate.score > best.score
        )
      ) {
        best = candidate;
      }

      current.value
        .slice(0, 500)
        .forEach((item, index) => {
          if (item && typeof item === 'object') {
            queue.push({
              value: item,
              path: `${current.path}[${index}]`
            });
          }
        });
    } else {
      Object.entries(current.value)
        .slice(0, 700)
        .forEach(([key, item]) => {
          if (item && typeof item === 'object') {
            queue.push({
              value: item,
              path: `${current.path}.${key}`
            });
          }
        });
    }
  }

  return (
    best &&
    best.score >= 110
      ? best
      : null
  );
}

function teamSignature(team) {
  return team
    .map(member => [
      normalizeKey(member.name),
      member.level ?? '',
      member.types.join(','),
      member.moves
        .map(move => [
          normalizeKey(
            move.identifier ||
            move.name
          ),
          move.currentPp ?? ''
        ].join(':'))
        .join(','),
      Object.keys(member.stats || {})
        .sort()
        .map(key => `${key}:${member.stats[key]}`)
        .join(','),
      member.hp.current ?? '',
      normalizeKey(member.heldItem || ''),
      member.heldItemObserved ? '1' : '0',
      member.active ? '1' : '0',
      member.fainted ? '1' : '0'
    ].join(':'))
    .join('|');
}


function playerTeamOrderSignature(team) {
  return (team || [])
    .map(member =>
      [
        normalizeKey(member?.name || ''),
        Number.isFinite(member?.level)
          ? member.level
          : ''
      ].join('|')
    )
    .join('>');
}

function playerTeamUpdateAuthority(
  found,
  detail
) {
  const source =
    normalizeKey(
      detail?.source || ''
    );

  const path =
    String(found?.path || '');

  const url =
    String(
      detail?.meta?.url || ''
    );

  let score = 0;

  if (
    [
      'fetch',
      'xhr',
      'websocket',
      'websocketmessage',
      'socket',
      'jsonparse'
    ].includes(source)
  ) {
    score += 400;
  } else if (
    source === 'localstorage' ||
    source === 'sessionstorage'
  ) {
    score += 80;
  } else {
    score += 160;
  }

  if (
    /(?:^|[.\[\]_-])partyjson(?:[.\[\]_-]|$)/i
      .test(path)
  ) {
    score += 320;
  } else if (
    /(?:^|[.\[\]_-])(party|team|lineup|squad|roster|playerparty|playerteam|activeteam)(?:[.\[\]_-]|$)/i
      .test(path)
  ) {
    score += 210;
  }

  if (
    /party|team|character|profile|save|state/i
      .test(url)
  ) {
    score += 70;
  }

  score +=
    Math.min(
      6,
      found?.members?.length || 0
    ) * 4;

  return score;
}

function clearActiveOpponentBattleState() {
  activeOpponentBattleState = null;
}

function clearActiveBattleAuthority() {
  activeBattleAuthorityEstablished = false;
  activeBattleAuthoritySlot = null;
  activeBattleAuthorityUpdatedAt = 0;
}

function hasActiveBattleAuthority() {
  return Boolean(
    activeBattleAuthorityEstablished &&
    activePlayerPokemon?.name &&
    activePlayerSwitchEventKey
  );
}

function clearActivePlayerForPartyLayoutChange() {
  activePlayerPokemon = null;
  activePlayerPokemonSource = null;
  activePlayerPokemonUpdatedAt = 0;

  activePlayerDomConfirmedAt = 0;
  activePlayerDomLockedKey = null;

  activePlayerSwitchEventKey = null;
  activePlayerSwitchEventSlot = null;
  activePlayerSwitchEventPokemon = null;
  activePlayerSwitchEventUpdatedAt = 0;

  if (activePlayerDomSyncTimer) {
    clearTimeout(activePlayerDomSyncTimer);
    activePlayerDomSyncTimer = null;
  }
}

function adoptCurrentPartyLead() {
  const lead =
    playerTeam.find(member =>
      member.order === 0 &&
      !member.fainted
    ) ||
    playerTeam.find(member =>
      !member.fainted
    ) ||
    null;

  if (!lead) {
    return false;
  }

  // A ordem do time é apenas um palpite inicial.
  // O Pokémon real do servidor ou um switch_in pode substituir
  // este valor imediatamente.
  return setActivePlayerPokemon(
    lead,
    'party-lead-layout'
  );
}

function updatePlayerTeam(root, detail) {
  const found =
    findBestPlayerTeam(root, detail);

  if (!found) {
    return false;
  }

  let nextTeam = found.members
    .map(hydrateMemberMovesFromCache);

  const previousOrder =
    playerTeamOrderSignature(
      playerTeam
    );

  const nextOrder =
    playerTeamOrderSignature(
      nextTeam
    );

  const layoutChanged =
    previousOrder !== nextOrder;

  const incomingAuthority =
    playerTeamUpdateAuthority(
      found,
      detail
    );

  // Do not let an older browser-storage snapshot restore the former
  // first slot immediately after the game returned a newer party order.
  if (
    layoutChanged &&
    playerTeam.length &&
    incomingAuthority <
      playerTeamLayoutAuthority &&
    Date.now() -
      playerTeamLayoutUpdatedAt <
      30000
  ) {
    return false;
  }

  if (
    playerTeam.length === nextTeam.length &&
    playerTeam.every(
      (member, index) =>
        normalizeKey(member.name) ===
        normalizeKey(
          nextTeam[index]?.name || ''
        )
    )
  ) {
    nextTeam = nextTeam.map(
      (member, index) =>
        mergeTeamMember(
          playerTeam[index],
          member
        )
    );
  } else {
    const previousByName = new Map(
      playerTeam.map(member => [
        normalizeKey(member.name),
        member
      ])
    );

    nextTeam = nextTeam.map(member =>
      mergeTeamMember(
        previousByName.get(
          normalizeKey(member.name)
        ),
        member
      )
    );
  }

  nextTeam = nextTeam.map(
    hydrateMemberMovesFromCache
  );

  const changed =
    teamSignature(nextTeam) !==
    teamSignature(playerTeam);

  playerTeam = nextTeam;
  playerTeamUpdatedAt = Date.now();

  if (layoutChanged) {
    playerTeamLayoutAuthority =
      incomingAuthority;

    playerTeamLayoutUpdatedAt =
      Date.now();

    if (hasActiveBattleAuthority()) {
      // Character/PC saves can arrive after /battle/v2/start. They update
      // the party details, but state.you.mon remains the only identity
      // authority until the battle reaches a terminal result.
      playerTeam = playerTeam.map(member => ({
        ...member,
        active:
          member.order === activeBattleAuthoritySlot &&
          samePlayerPokemon(
            member,
            activePlayerPokemon
          )
      }));
    } else {
      // Outside a live authoritative battle, a real party reorder invalidates
      // the former lead and the first non-fainted slot becomes provisional.
      clearActivePlayerForPartyLayoutChange();
      adoptCurrentPartyLead();
    }
  } else {
    playerTeamLayoutAuthority =
      Math.max(
        playerTeamLayoutAuthority,
        incomingAuthority
      );
  }

  rememberTeamMoves(playerTeam);

  return changed || layoutChanged;
}


function clearActiveBattlePartyAvailability() {
  activeBattlePartyAvailability = new Map();
  activeBattlePartyBattleId = null;
}

function partyAvailabilitySignature(map) {
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, value]) =>
      [
        slot,
        normalizeKey(value.species || ''),
        value.hp ?? '',
        value.maxHp ?? '',
        value.fainted ? '1' : '0'
      ].join(':')
    )
    .join('|');
}

function syncPlayerPartyAvailabilityFromBattleState(
  root,
  detail
) {
  const url = String(
    detail?.meta?.url || ''
  );

  const battleId =
    typeof root?.battleId === 'string'
      ? root.battleId
      : null;

  const isBattleStart =
    /\/api\/battle\/v2\/start(?:[?#]|$)/i
      .test(url);

  if (
    isBattleStart ||
    (
      battleId &&
      activeBattlePartyBattleId &&
      battleId !== activeBattlePartyBattleId
    )
  ) {
    clearActiveBattlePartyAvailability();
  }

  const party =
    root?.state?.you?.party;

  if (!Array.isArray(party)) {
    return false;
  }

  const next = new Map();

  party
    .slice(0, 6)
    .forEach((entry, slot) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }

      const hp =
        numberInRange(
          getByAliases(entry, [
            'hp',
            'currentHp',
            'current_hp'
          ]),
          0,
          99999
        );

      const maxHp =
        numberInRange(
          getByAliases(entry, [
            'maxHp',
            'max_hp'
          ]),
          1,
          99999
        );

      const fainted =
        booleanLike(
          getByAliases(entry, [
            'fainted',
            'isFainted',
            'is_fainted',
            'defeated',
            'isDefeated',
            'is_defeated'
          ])
        ) === true ||
        hp === 0;

      next.set(slot, {
        species:
          normalizeKey(
            getByAliases(entry, [
              'species',
              'name'
            ]) || ''
          ),
        hp,
        maxHp,
        fainted
      });
    });

  if (!next.size) {
    return false;
  }

  activeBattlePartyBattleId =
    battleId ||
    activeBattlePartyBattleId ||
    null;

  const changed =
    partyAvailabilitySignature(next) !==
    partyAvailabilitySignature(
      activeBattlePartyAvailability
    );

  activeBattlePartyAvailability = next;

  // Also overlay the live HP/fainted state onto the detected team so every
  // consumer sees the same server-confirmed availability.
  playerTeam = playerTeam.map(member => {
    const live =
      activeBattlePartyAvailability.get(
        member.order
      );

    if (!live) {
      return member;
    }

    if (
      live.species &&
      normalizeKey(member.name) !==
        live.species &&
      normalizeKey(member.species || '') !==
        live.species
    ) {
      return member;
    }

    return {
      ...member,
      hp: {
        current:
          live.hp ??
          member.hp?.current ??
          null,
        maximum:
          live.maxHp ??
          member.hp?.maximum ??
          null
      },
      fainted: live.fainted
    };
  });

  return changed;
}

function recommendationMemberIsInCurrentPlayerParty(
  member
) {
  if (!member) {
    return false;
  }

  if (!activeEncounter) {
    return true;
  }

  if (!activeBattlePartyAvailability.size) {
    return false;
  }

  const live =
    activeBattlePartyAvailability.get(
      member.order
    );

  if (!live) {
    return false;
  }

  const memberKeys = new Set(
    [member.name, member.species]
      .map(value =>
        normalizeKey(value || '')
      )
      .filter(Boolean)
  );

  if (!live.species) {
    return memberKeys.size > 0;
  }

  return memberKeys.has(
    live.species
  );
}


function recommendationCurrentPlayerTeam() {
  if (!activeEncounter) {
    return [...playerTeam];
  }

  if (!activeBattlePartyAvailability.size) {
    return [];
  }

  return playerTeam.filter(
    recommendationMemberIsInCurrentPlayerParty
  );
}


function recommendationMemberIsFainted(
  member
) {
  if (!member) {
    return true;
  }

  const live =
    activeBattlePartyAvailability.get(
      member.order
    );

  if (live) {
    const speciesMatches =
      !live.species ||
      live.species ===
        normalizeKey(member.name) ||
      live.species ===
        normalizeKey(
          member.species || ''
        );

    if (speciesMatches) {
      return Boolean(live.fainted);
    }
  }

  return Boolean(
    member.fainted ||
    member.hp?.current === 0
  );
}


function recommendationAttackMultiplier(
  attackType,
  defenderTypes
) {
  if (
    !attackType ||
    !defenderTypes?.length
  ) {
    return 1;
  }

  return defenderTypes.reduce(
    (value, defenderType) =>
      value *
      multiplierFor(
        attackType,
        defenderType
      ),
    1
  );
}


function normalizeRecommendationAbility(ability) {
  return normalizeKey(ability || '');
}

function abilityAdjustedAttackMultiplier(
  attackType,
  defenderTypes,
  defenderAbility
) {
  let multiplier =
    recommendationAttackMultiplier(
      attackType,
      defenderTypes
    );

  const ability =
    normalizeRecommendationAbility(
      defenderAbility
    );

  if (!ability) {
    return multiplier;
  }

  // Complete immunities.
  if (
    attackType === 'ground' &&
    ability === 'levitate'
  ) {
    return 0;
  }

  if (
    attackType === 'water' &&
    [
      'waterabsorb',
      'stormdrain',
      'dryskin'
    ].includes(ability)
  ) {
    return 0;
  }

  if (
    attackType === 'electric' &&
    [
      'voltabsorb',
      'lightningrod',
      'motordrive'
    ].includes(ability)
  ) {
    return 0;
  }

  if (
    attackType === 'fire' &&
    ability === 'flashfire'
  ) {
    return 0;
  }

  if (
    attackType === 'grass' &&
    ability === 'sapsipper'
  ) {
    return 0;
  }

  if (
    attackType === 'normal' &&
    ability === 'soundproof'
  ) {
    // Soundproof is move-specific, so generic Normal-type scoring
    // must not be changed here.
    return multiplier;
  }

  // Damage-reducing abilities that are reliably type-based.
  if (
    ability === 'thickfat' &&
    (
      attackType === 'fire' ||
      attackType === 'ice'
    )
  ) {
    multiplier *= 0.5;
  }

  if (
    ability === 'heatproof' &&
    attackType === 'fire'
  ) {
    multiplier *= 0.5;
  }

  if (
    ability === 'purifyingsalt' &&
    attackType === 'ghost'
  ) {
    multiplier *= 0.5;
  }

  return multiplier;
}

function recommendationDefenseMultiplier(
  attackType,
  defenderTypes
) {
  if (
    !attackType ||
    !defenderTypes?.length
  ) {
    return 1;
  }

  return defenderTypes.reduce(
    (value, defenderType) =>
      value *
      multiplierFor(
        attackType,
        defenderType
      ),
    1
  );
}

function typeOnlyOffensiveScore(multiplier) {
  if (multiplier >= 4) return 180;
  if (multiplier >= 2) return 110;
  if (multiplier > 1) return 70;
  if (multiplier === 1) return 25;
  if (multiplier >= 0.5) return -20;
  if (multiplier > 0) return -55;
  return -135;
}

function typeOnlyDefensiveScore(multiplier) {
  if (multiplier === 0) return 60;
  if (multiplier <= 0.25) return 40;
  if (multiplier <= 0.5) return 25;
  if (multiplier < 1) return 12;
  if (multiplier === 1) return 0;
  if (multiplier >= 4) return -100;
  if (multiplier >= 2) return -55;
  return -25;
}

function scoreTypeOnlyMember(
  member,
  opponentTypes,
  opponentAbility
) {
  if (
    recommendationMemberIsFainted(
      member
    ) ||
    !member.types.length
  ) {
    return {
      member,
      unavailable: true,
      score: -9999
    };
  }

  const outgoing =
    member.types.map(type => ({
      type,
      multiplier:
        abilityAdjustedAttackMultiplier(
          type,
          opponentTypes,
          opponentAbility
        )
    }));

  outgoing.sort(
    (a, b) =>
      b.multiplier - a.multiplier
  );

  const bestOutgoing =
    outgoing[0] || {
      type: null,
      multiplier: 1
    };

  const incoming =
    opponentTypes.map(type =>
      recommendationDefenseMultiplier(
        type,
        member.types
      )
    );

  const worstIncoming =
    incoming.length
      ? Math.max(...incoming)
      : 1;

  let score =
    typeOnlyOffensiveScore(
      bestOutgoing.multiplier
    ) +
    typeOnlyDefensiveScore(
      worstIncoming
    );

  score -= member.order * 0.01;

  return {
    member,
    score,
    bestOutgoing,
    worstIncoming
  };
}


function recommendationMoveScore(
  move,
  memberTypes,
  opponentTypes,
  opponentAbility
) {
  if (
    !move?.type ||
    move.damageClass === 'status' ||
    move.currentPp === 0
  ) {
    return null;
  }

  const multiplier =
    abilityAdjustedAttackMultiplier(
      move.type,
      opponentTypes,
      opponentAbility
    );

  const stab =
    memberTypes.includes(move.type);

  const power =
    Number.isFinite(move.power)
      ? move.power
      : 60;

  return {
    move,
    multiplier,
    stab,
    blockedByAbility:
      multiplier === 0 &&
      recommendationAttackMultiplier(
        move.type,
        opponentTypes
      ) > 0,
    score:
      power *
      multiplier *
      (stab ? 1.5 : 1)
  };
}

function bestMoveForRecommendedPokemon(
  member,
  opponentTypes,
  opponentAbility
) {
  const ranked = (member.moves || [])
    .map(move =>
      recommendationMoveScore(
        move,
        member.types,
        opponentTypes,
        opponentAbility
      )
    )
    .filter(Boolean)
    .sort((a, b) => {
      if (b.multiplier !== a.multiplier) {
        return b.multiplier - a.multiplier;
      }

      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return Number(b.stab) - Number(a.stab);
    });

  return ranked[0] || null;
}

function buildTypeOnlyRecommendation(
  opponentMeta
) {
  if (!playerTeam.length) {
    return {
      status: 'waiting',
      message:
        'Aguardando o jogo enviar seu time.'
    };
  }

  const currentPlayerTeam =
    recommendationCurrentPlayerTeam();

  if (
    activeEncounter &&
    !activeBattlePartyAvailability.size
  ) {
    return {
      status: 'waiting',
      message:
        'Validando o time atual do jogador.'
    };
  }

  if (!currentPlayerTeam.length) {
    return {
      status: 'waiting',
      message:
        'Aguardando a confirmação do seu time atual.'
    };
  }

  if (!opponentMeta?.types?.length) {
    return {
      status: 'waiting',
      message:
        'Time encontrado, aguardando o tipo do adversário.'
    };
  }

  const ranked = currentPlayerTeam
    .map(member =>
      scoreTypeOnlyMember(
        member,
        opponentMeta.types,
        opponentMeta.ability
      )
    )
    .filter(item => !item.unavailable)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return {
      status: 'unavailable',
      message:
        'Nenhum Pokémon disponível foi reconhecido no time.'
    };
  }

  return {
    status: 'ready',
    best: ranked[0],
    opponentAbility:
      opponentMeta.ability || null,
    teamCount: currentPlayerTeam.length
  };
}

function typeRecommendationCardHtml(
  opponentMeta
) {
  const result =
    buildTypeOnlyRecommendation(
      opponentMeta
    );

  if (result.status !== 'ready') {
    return `
      <section
        id="ih-type-recommendation"
        class="ih-card ih-recommendation-card ih-recommendation-waiting"
      >
        <h3>
          RECOMENDAÇÃO
          <small>MELHOR POKÉMON DO TIME</small>
        </h3>

        <p>${escapeHtml(result.message)}</p>
      </section>
    `;
  }

  const best = result.best;

  return `
    <section
      id="ih-type-recommendation"
      class="ih-card ih-recommendation-card"
    >
      <h3>
        RECOMENDAÇÃO
        <small>${result.teamCount}/6 LIDOS</small>
      </h3>

      <div class="ih-recommendation-best">
        <span>MELHOR POKÉMON</span>
        <strong>${escapeHtml(best.member.name)}</strong>
        ${
          best.member.level
            ? `<small>Nível ${best.member.level}</small>`
            : ''
        }
      </div>

      ${
        result.opponentAbility
          ? `
            <p class="ih-recommendation-ability">
              Habilidade adversária considerada:
              <strong>${escapeHtml(result.opponentAbility)}</strong>
            </p>
          `
          : ''
      }

      <p class="ih-recommendation-note">
        Recomendação por tipos e habilidades, sem troca automática.
      </p>
    </section>
  `;
}

function enforceFixedPanelBlockOrder() {
  if (!body) return;

  const source =
    body.querySelector('.ih-source');

  const cards = [
    body.querySelector('.ih-effect-card'),
    body.querySelector('#ih-type-recommendation'),
    body.querySelector('#ih-ko-forecast'),
    body.querySelector('#ih-capture-forecast')
  ].filter(Boolean);

  for (const card of cards) {
    body.insertBefore(
      card,
      source || null
    );
  }
}


function refreshTypeRecommendation() {
  if (!body) return;

  const existing =
    body.querySelector(
      '#ih-type-recommendation'
    );

  if (existing) {
    existing.remove();
  }

  if (!activeEncounter?.snapshot) {
    return;
  }

  const source =
    body.querySelector('.ih-source');

  const html =
    typeRecommendationCardHtml(
      activeEncounter.snapshot.meta
    );

  if (source) {
    source.insertAdjacentHTML(
      'beforebegin',
      html
    );
  } else {
    body.insertAdjacentHTML(
      'beforeend',
      html
    );
  }

  prepareCollapsibleSections();
  enforceFixedPanelBlockOrder();

  if (knownTeamMoveCount() === 0) {
    readStorageDirectlyForMoves();
    scheduleMoveRescanLoop(
      'recommendation-zero-moves'
    );
  } else {
    stopMoveRescanLoop();
  }
}


const ACTIVE_PLAYER_SIDE_CONTEXT =
  /(?:^|[.\[\]_/:-])(player|self|mine|my|ally|you|your|user)(?:[.\[\]_/:-]|$)/i;

const ACTIVE_PLAYER_DIRECT_PATH =
  /(?:^|[.\[\]_/:-])(player|self|mine|my|ally|you|your|user)(?:[.\[\]_/:-]+)(mon|pokemon|activepokemon|currentpokemon|active_pokemon|current_pokemon|battler|activebattler|active_battler)(?:[.\[\]_/:-]|$)/i;

const ACTIVE_PLAYER_ROOT_PATH =
  /(?:^|[.\[\]_/:-])(playerpokemon|player_pokemon|mypokemon|my_pokemon|activeplayerpokemon|active_player_pokemon|currentplayerpokemon|current_player_pokemon)(?:[.\[\]_/:-]|$)/i;


const ACTIVE_PLAYER_BATTLE_MON_PATH =
  /^(?:\$|\$\.state|\$\.battle|\$\.combat|\$\.duel|\$\.character|\$\.playerstate)\.(?:mon|pokemon|activemon|active_mon|currentmon|current_mon|activepokemon|active_pokemon|currentpokemon|current_pokemon|battler|activebattler|active_battler)$/i;

const ACTIVE_PLAYER_OPPONENT_CONTEXT =
  /(?:^|[.\[\]_/:-])(foe|opponent|enemy|rival|trainer|npc|leader|boss)(?:[.\[\]_/:-]|$)/i;

const ACTIVE_PLAYER_TEAM_COLLECTION =
  /(?:^|[.\[\]_/:-])(party|team|lineup|squad|roster)(?:[.\[\]_/:-]|$)/i;

const ACTIVE_DOM_CONFIRMATION_MS = 12000;

const ACTIVE_MOVE_ELEMENT_SELECTOR = [
  'button',
  '[role="button"]',
  '[data-move]',
  '[data-move-name]',
  '[data-attack]',
  '[data-attack-name]',
  '[class*="move"]',
  '[class*="Move"]',
  '[class*="attack"]',
  '[class*="Attack"]',
  '[class*="skill"]',
  '[class*="Skill"]'
].join(',');

function hasDirectPlayerPokemonAlias(object) {
  if (!object || typeof object !== 'object') {
    return false;
  }

  const value = getByAliases(object, [
    'mon',
    'pokemon',
    'activePokemon',
    'active_pokemon',
    'currentPokemon',
    'current_pokemon',
    'battler',
    'activeBattler',
    'active_battler'
  ]);

  return Boolean(
    value &&
    typeof value === 'object'
  );
}


function hasDirectOpponentPokemonAlias(object) {
  if (!object || typeof object !== 'object') {
    return false;
  }

  const value = getByAliases(object, [
    'foe',
    'opponent',
    'enemy',
    'rival'
  ]);

  return Boolean(
    value &&
    typeof value === 'object'
  );
}

function scoreActivePlayerObject(
  object,
  path,
  detail
) {
  if (!object || typeof object !== 'object') {
    return null;
  }

  const pathText = String(path || '');

  if (
    ACTIVE_PLAYER_OPPONENT_CONTEXT.test(pathText)
  ) {
    return null;
  }

  const unwrapped =
    playerTeamPokemonObject(object);

  const member = buildPlayerTeamMember(
    unwrapped,
    pathText,
    detail,
    -1
  );

  if (!member?.name) {
    return null;
  }

  const teamMatch =
    matchingPlayerTeamMember(member);

  if (
    playerTeam.length &&
    !teamMatch
  ) {
    return null;
  }

  if (
    !playerTeam.length &&
    !PokemonData.byName[
      normalizeKey(member.name)
    ]
  ) {
    return null;
  }

  const resolvedMember =
    teamMatch
      ? mergeTeamMember(
          teamMatch,
          member
        )
      : member;

  const explicitActive =
    hasExplicitActivePlayerFlag(
      unwrapped
    ) ||
    hasExplicitActivePlayerFlag(object);

  const directPlayerPath =
    ACTIVE_PLAYER_DIRECT_PATH.test(pathText);

  const rootPlayerPath =
    ACTIVE_PLAYER_ROOT_PATH.test(pathText);

  // Real InfinityMMO battle updates commonly expose the player's
  // current battler directly as $.mon while the opponent is $.foe.
  const battleMonPath =
    ACTIVE_PLAYER_BATTLE_MON_PATH.test(
      pathText
    );

  const playerSide =
    ACTIVE_PLAYER_SIDE_CONTEXT.test(pathText);

  const teamCollection =
    ACTIVE_PLAYER_TEAM_COLLECTION.test(pathText);

  const battleContext =
    /battle|combat|duel|fight|state/i.test(
      teamContextText(pathText, detail)
    );

  const sideContainer =
    playerSide &&
    hasDirectPlayerPokemonAlias(object);

  // Root packet with both `mon` and `foe`: `mon` is the player battler.
  const rootBattleContainer =
    pathText === '$' &&
    hasDirectPlayerPokemonAlias(object) &&
    hasDirectOpponentPokemonAlias(object);

  if (
    teamCollection &&
    !explicitActive &&
    !directPlayerPath &&
    !rootPlayerPath &&
    !battleMonPath &&
    !sideContainer &&
    !rootBattleContainer
  ) {
    return null;
  }

  let score = 0;

  if (rootBattleContainer) score += 620;
  if (battleMonPath) score += 560;
  if (directPlayerPath) score += 340;
  if (rootPlayerPath) score += 340;
  if (sideContainer) score += 290;
  if (explicitActive) score += 280;
  if (playerSide) score += 60;
  if (battleContext) score += 55;
  if (teamMatch) score += 180;

  score += resolvedMember.moves.length * 12;
  score += resolvedMember.types.length * 5;
  score +=
    Object.keys(
      resolvedMember.stats || {}
    ).length * 3;

  if (
    detail?.source === 'localStorage' ||
    detail?.source === 'sessionStorage'
  ) {
    score -= 70;
  }

  return score >= 300
    ? {
        member: resolvedMember,
        score,
        path: pathText,
        rootBattleContainer,
        battleMonPath
      }
    : null;
}

function findBestActivePlayerPokemon(
  root,
  detail
) {
  if (!root || typeof root !== 'object') {
    return null;
  }

  const queue = [{
    value: root,
    path: '$'
  }];

  const seen = new WeakSet();
  let best = null;
  let inspected = 0;

  while (queue.length && inspected < 9000) {
    const current = queue.shift();
    inspected++;

    if (
      !current.value ||
      typeof current.value !== 'object' ||
      seen.has(current.value)
    ) {
      continue;
    }

    seen.add(current.value);

    const candidate =
      scoreActivePlayerObject(
        current.value,
        current.path,
        detail
      );

    if (candidate) {
      const candidatePriority =
        candidate.rootBattleContainer
          ? 3
          : candidate.battleMonPath
            ? 2
            : 1;

      const bestPriority =
        best?.rootBattleContainer
          ? 3
          : best?.battleMonPath
            ? 2
            : best
              ? 1
              : 0;

      if (
        !best ||
        candidatePriority > bestPriority ||
        (
          candidatePriority === bestPriority &&
          candidate.score > best.score
        )
      ) {
        best = candidate;
      }
    }

    if (Array.isArray(current.value)) {
      current.value
        .slice(0, 500)
        .forEach((item, index) => {
          if (item && typeof item === 'object') {
            queue.push({
              value: item,
              path: `${current.path}[${index}]`
            });
          }
        });
    } else {
      Object.entries(current.value)
        .slice(0, 700)
        .forEach(([key, item]) => {
          if (item && typeof item === 'object') {
            queue.push({
              value: item,
              path: `${current.path}.${key}`
            });
          }
        });
    }
  }

  return best;
}

function samePlayerPokemon(
  first,
  second
) {
  if (!first || !second) return false;

  if (
    normalizeKey(first.name) !==
    normalizeKey(second.name)
  ) {
    return false;
  }

  if (
    Number.isFinite(first.level) &&
    Number.isFinite(second.level) &&
    first.level !== second.level
  ) {
    return false;
  }

  return true;
}

function activePlayerSignature(member) {
  if (!member) return '';

  return [
    normalizeKey(member.name),
    member.level ?? '',
    member.moves
      .map(move =>
        normalizeKey(
          move.identifier ||
          move.name
        )
      )
      .join(','),
    Object.keys(member.stats || {})
      .sort()
      .map(key => `${key}:${member.stats[key]}`)
      .join(','),
    member.hp?.current ?? '',
    member.hp?.maximum ?? '',
    normalizeKey(member.heldItem || ''),
    member.heldItemObserved ? '1' : '0',
    member.fainted ? '1' : '0'
  ].join('|');
}

function matchingPlayerTeamMember(member) {
  if (!member) return null;

  if (Number.isFinite(member.order)) {
    const sameSlot = playerTeam.find(candidate =>
      candidate.order === member.order &&
      samePlayerPokemon(candidate, member)
    );

    if (sameSlot) return sameSlot;
  }

  const exact = playerTeam.find(candidate =>
    samePlayerPokemon(candidate, member)
  );

  if (exact) return exact;

  return playerTeam.find(candidate =>
    normalizeKey(candidate.name) ===
    normalizeKey(member.name)
  ) || null;
}

function resolveActivePlayerTeamMember() {
  const switchEventMember =
    lockedActivePlayerSwitchEventMember();

  if (switchEventMember) {
    return switchEventMember;
  }

  clearInvalidActivePromptLock();

  const lockedMember =
    lockedActivePlayerTeamMember();

  if (lockedMember) {
    return lockedMember;
  }

  if (activePlayerPokemon) {
    const teamMember =
      matchingPlayerTeamMember(
        activePlayerPokemon
      );

    if (teamMember) {
      const merged =
        mergeTeamMember(
          teamMember,
          activePlayerPokemon
        );

      if (!merged.fainted) {
        return merged;
      }
    } else if (!playerTeam.length) {
      if (!activePlayerPokemon.fainted) {
        return activePlayerPokemon;
      }
    }
  }

  const flagged =
    playerTeam.find(member =>
      member.active === true &&
      !member.fainted
    );

  if (flagged) {
    return flagged;
  }

  return null;
}

function elementIsVisibleForActiveMove(element) {
  if (
    !element ||
    !(element instanceof Element) ||
    element.closest('#infinity-help-panel')
  ) {
    return false;
  }

  const style = window.getComputedStyle(element);

  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    Number(style.opacity) === 0
  ) {
    return false;
  }

  const rect = element.getBoundingClientRect();

  return (
    rect.width > 8 &&
    rect.height > 8 &&
    rect.bottom >= 0 &&
    rect.right >= 0 &&
    rect.top <= window.innerHeight &&
    rect.left <= window.innerWidth
  );
}

function activeMoveElementTexts(element) {
  const values = [
    element.textContent,
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    element.getAttribute('data-move'),
    element.getAttribute('data-move-name'),
    element.getAttribute('data-attack'),
    element.getAttribute('data-attack-name'),
    element instanceof HTMLInputElement
      ? element.value
      : null
  ];

  return [...new Set(
    values
      .filter(value =>
        typeof value === 'string' &&
        value.trim()
      )
      .map(value => value.trim())
  )];
}

function moveKeysForMember(member) {
  const output = new Set();

  for (const move of member?.moves || []) {
    for (const value of [
      move.name,
      move.identifier,
      String(move.identifier || '')
        .replace(/-/g, ' ')
    ]) {
      const key = normalizeKey(value);

      if (key.length >= 3) {
        output.add(key);
      }
    }
  }

  return output;
}

function textMatchesMoveKey(text, moveKey) {
  const normalized = normalizeKey(text);

  if (!normalized || !moveKey) {
    return false;
  }

  if (normalized === moveKey) {
    return true;
  }

  return (
    normalized.startsWith(moveKey) &&
    normalized.length <= moveKey.length + 20
  );
}

function collectVisibleBattleMoveEvidence() {
  const elements = [
    ...document.querySelectorAll(
      ACTIVE_MOVE_ELEMENT_SELECTOR
    )
  ].slice(0, 700);

  const evidence = [];

  for (const element of elements) {
    if (!elementIsVisibleForActiveMove(element)) {
      continue;
    }

    const texts = activeMoveElementTexts(element);

    if (texts.length) {
      evidence.push(texts);
    }
  }

  return evidence;
}

function scoreMemberAgainstVisibleMoves(
  member,
  evidence
) {
  const moveKeys = moveKeysForMember(member);
  const matchedMoves = new Set();

  for (const texts of evidence) {
    for (const text of texts) {
      for (const moveKey of moveKeys) {
        if (textMatchesMoveKey(text, moveKey)) {
          matchedMoves.add(moveKey);
        }
      }
    }
  }

  return {
    member,
    matches: matchedMoves.size
  };
}


const MOVE_DATABASE_KEYS =
  Object.keys(MoveData.byName)
    .sort((a, b) => b.length - a.length);

function visibleMoveRecordFromText(text) {
  const normalized = normalizeKey(text);

  if (!normalized || normalized.length < 3) {
    return null;
  }

  let key = null;

  if (MoveData.byName[normalized]) {
    key = normalized;
  } else {
    key = MOVE_DATABASE_KEYS.find(candidate =>
      normalized.startsWith(candidate) &&
      normalized.length <= candidate.length + 22
    ) || null;
  }

  if (!key) return null;

  const data = MoveData.byName[key];

  if (!data) return null;

  return {
    name:
      String(data[0] || key)
        .split('-')
        .map(part =>
          part
            ? part[0].toUpperCase() +
              part.slice(1)
            : part
        )
        .join(' '),
    identifier: data[0] || key,
    type: data[1] || null,
    power:
      Number.isFinite(Number(data[2]))
        ? Number(data[2])
        : null,
    damageClass: data[3] || 'status',
    accuracy:
      Number.isFinite(Number(data[4]))
        ? Number(data[4])
        : null,
    currentPp: null
  };
}

function visibleBattleMoveRecords() {
  const records = [];
  const used = new Set();

  for (const item of
    collectVisibleBattleMoveEvidence()) {
    for (const text of item) {
      const move =
        visibleMoveRecordFromText(text);

      if (!move) continue;

      const key = normalizeKey(
        move.identifier ||
        move.name
      );

      if (!key || used.has(key)) {
        continue;
      }

      used.add(key);
      records.push(move);

      if (records.length >= 4) {
        return records;
      }
    }
  }

  return records;
}

function visibleTeamNameMatches() {
  if (!playerTeam.length) {
    return [];
  }

  const members = playerTeam
    .filter(member => !member.fainted)
    .map(member => ({
      member,
      key: normalizeKey(member.name)
    }))
    .filter(item => item.key);

  const scores = new Map(
    members.map(item => [
      item.key,
      {
        member: item.member,
        score: 0,
        evidence: null
      }
    ])
  );

  for (const text of
    visibleGameTextSamples()) {
    const normalized =
      normalizeKey(text);

    if (!normalized) continue;

    for (const item of members) {
      const name = item.key;
      let score = 0;
      let evidence = null;

      const commandPromptPatterns = [
        `oque${name}fara`,
        `oque${name}vaifazer`,
        `whatwill${name}do`,
        `quehara${name}`,
        `quevaahacer${name}`
      ];

      const sendOutPatterns = [
        `vai${name}`,
        `vamos${name}`,
        `go${name}`,
        `goahead${name}`,
        `adelante${name}`,
        `${name}euescolhovoce`,
        `${name}entrouemcampo`,
        `${name}foienviado`,
        `${name}wassentout`
      ].map(normalizeKey);

      if (
        commandPromptPatterns.some(pattern =>
          normalized.includes(pattern)
        ) ||
        sendOutPatterns.some(pattern =>
          normalized.includes(pattern)
        )
      ) {
        // A mensagem do próprio jogo informa quem realmente entrou,
        // mesmo quando slots anteriores estão derrotados.
        score = 1400;
        evidence = 'prompt';
      } else if (normalized === name) {
        score = 520;
        evidence = 'exact';
      } else if (
        normalized.startsWith(name) &&
        (
          normalized.includes('lv') ||
          normalized.includes('nivel') ||
          normalized.includes('hp')
        )
      ) {
        score = 430;
        evidence = 'status';
      } else if (
        normalized.includes(name) &&
        (
          normalized.includes('fara') ||
          normalized.includes('vaifazer') ||
          normalized.includes('will') ||
          normalized.includes('nivel') ||
          normalized.includes('lv') ||
          normalized.includes('entrouemcampo') ||
          normalized.includes('foienviado')
        )
      ) {
        score = 360;
        evidence = 'context';
      }

      if (!score) continue;

      const current = scores.get(name);

      if (score > current.score) {
        current.score = score;
        current.evidence = evidence;
      }
    }
  }

  const ranked = [...scores.values()]
    .filter(item => item.score > 0)
    .sort((a, b) =>
      b.score - a.score
    );

  if (!ranked.length) {
    return [];
  }

  const best = ranked[0];
  const second = ranked[1];

  if (
    second &&
    second.score === best.score
  ) {
    return [];
  }

  if (best.score < 360) {
    return [];
  }

  return [{
    ...best.member,
    visibleEvidence:
      best.evidence,
    visibleScore:
      best.score
  }];
}

function enrichMemberWithVisibleMoves(
  member,
  visibleMoves
) {
  if (!member || !visibleMoves.length) {
    return member;
  }

  const enriched = {
    ...member,
    moves: mergeTeamMoveLists(
      member.moves,
      visibleMoves
    )
  };

  rememberMemberMoves(enriched);

  const index = playerTeam.findIndex(candidate =>
    samePlayerPokemon(
      candidate,
      enriched
    )
  );

  if (index >= 0) {
    playerTeam[index] =
      mergeTeamMember(
        playerTeam[index],
        enriched
      );
  }

  return enriched;
}

function findActivePlayerFromVisibleMoves() {
  if (
    !activeEncounter ||
    !playerTeam.length
  ) {
    return null;
  }

  clearInvalidActivePromptLock();

  const visibleMoves =
    visibleBattleMoveRecords();

  const visibleNames =
    visibleTeamNameMatches();

  const promptMember =
    visibleNames.find(member =>
      member.visibleEvidence ===
      'prompt'
    );

  if (promptMember) {
    return {
      member: promptMember,
      matches: 0,
      source: 'dom-prompt'
    };
  }

  const lockedMember =
    lockedActivePlayerTeamMember();

  if (lockedMember) {
    return {
      member:
        visibleMoves.length
          ? enrichMemberWithVisibleMoves(
              lockedMember,
              visibleMoves
            )
          : lockedMember,
      matches: visibleMoves.length,
      source:
        visibleMoves.length
          ? 'dom-active-moves'
          : 'dom-locked-active'
    };
  }

  if (visibleNames.length === 1) {
    const member =
      visibleNames[0];

    return {
      member:
        enrichMemberWithVisibleMoves(
          member,
          visibleMoves
        ),
      matches: visibleMoves.length,
      source: 'dom-visible-name'
    };
  }

  const evidence =
    collectVisibleBattleMoveEvidence();

  if (!evidence.length) {
    return null;
  }

  const ranked = playerTeam
    .filter(member =>
      !member.fainted &&
      member.moves?.length
    )
    .map(member =>
      scoreMemberAgainstVisibleMoves(
        member,
        evidence
      )
    )
    .sort((first, second) =>
      second.matches - first.matches
    );

  const best = ranked[0];
  const second = ranked[1];

  if (!best || best.matches < 2) {
    return null;
  }

  if (
    second &&
    second.matches === best.matches
  ) {
    return null;
  }

  return {
    ...best,
    member:
      enrichMemberWithVisibleMoves(
        best.member,
        visibleMoves
      ),
    source: 'dom-visible-moves'
  };
}



function battleEventType(event) {
  return normalizeKey(
    getByAliases(event, [
      't',
      'event',
      'eventType',
      'event_type',
      'type',
      'kind'
    ]) || ''
  );
}

function battleEventSide(event) {
  return normalizeKey(
    getByAliases(event, [
      'side',
      'team',
      'owner',
      'targetSide',
      'target_side'
    ]) || ''
  );
}

function isPlayerBattleSide(value) {
  return new Set([
    'you',
    'your',
    'player',
    'self',
    'me',
    'my',
    'mine',
    'own',
    'user',
    'ally',
    'jogador',
    'voce'
  ]).has(normalizeKey(value));
}

function playerSwitchEventRecord(
  event,
  path,
  detail
) {
  if (
    !event ||
    typeof event !== 'object' ||
    Array.isArray(event)
  ) {
    return null;
  }

  const type = battleEventType(event);

  if (
    type !== 'switchin' &&
    type !== 'sendout' &&
    type !== 'sentout'
  ) {
    return null;
  }

  if (
    !isPlayerBattleSide(
      battleEventSide(event)
    )
  ) {
    return null;
  }

  const mon = getByAliases(event, [
    'mon',
    'pokemon',
    'activePokemon',
    'active_pokemon',
    'battler',
    'creature',
    'member'
  ]);

  if (
    !mon ||
    typeof mon !== 'object'
  ) {
    return null;
  }

  const slot =
    numberInRange(
      getByAliases(event, [
        'slot',
        'index',
        'partyIndex',
        'party_index',
        'teamIndex',
        'team_index'
      ]),
      0,
      5
    );

  const member =
    buildPlayerTeamMember(
      mon,
      `${path}.mon`,
      detail,
      slot ?? -1
    );

  if (!member?.name) {
    return null;
  }

  return {
    member,
    slot,
    path
  };
}

function findLatestPlayerSwitchEvent(
  root,
  detail
) {
  if (!root || typeof root !== 'object') {
    return null;
  }

  const stack = [{
    value: root,
    path: '$'
  }];

  const seen = new WeakSet();
  let latest = null;
  let inspected = 0;

  while (stack.length && inspected < 10000) {
    const current = stack.pop();
    inspected++;

    if (
      !current.value ||
      typeof current.value !== 'object' ||
      seen.has(current.value)
    ) {
      continue;
    }

    seen.add(current.value);

    const record =
      playerSwitchEventRecord(
        current.value,
        current.path,
        detail
      );

    if (record) {
      latest = record;
    }

    if (Array.isArray(current.value)) {
      for (
        let index = current.value.length - 1;
        index >= 0;
        index--
      ) {
        const item = current.value[index];

        if (item && typeof item === 'object') {
          stack.push({
            value: item,
            path: `${current.path}[${index}]`
          });
        }
      }
    } else {
      const entries =
        Object.entries(current.value);

      for (
        let index = entries.length - 1;
        index >= 0;
        index--
      ) {
        const [key, item] = entries[index];

        if (item && typeof item === 'object') {
          stack.push({
            value: item,
            path: `${current.path}.${key}`
          });
        }
      }
    }
  }

  return latest;
}

function lockedActivePlayerSwitchEventMember() {
  if (
    !activePlayerSwitchEventKey ||
    !activePlayerSwitchEventPokemon
  ) {
    return null;
  }

  let member =
    activePlayerSwitchEventPokemon;

  const slotMember =
    Number.isFinite(activePlayerSwitchEventSlot)
      ? playerTeam.find(candidate =>
          candidate.order ===
            activePlayerSwitchEventSlot &&
          activePlayerIdentityKey(candidate) ===
            activePlayerSwitchEventKey
        )
      : null;

  const teamMember =
    slotMember ||
    playerTeam.find(candidate =>
      activePlayerIdentityKey(candidate) ===
      activePlayerSwitchEventKey
    );

  if (teamMember) {
    member = mergeTeamMember(
      teamMember,
      member
    );
  }

  if (
    activePlayerPokemon &&
    activePlayerIdentityKey(
      activePlayerPokemon
    ) === activePlayerSwitchEventKey
  ) {
    member = mergeTeamMember(
      member,
      activePlayerPokemon
    );
  }

  return member.fainted
    ? null
    : member;
}

function updateActivePlayerFromSwitchEvents(
  root,
  detail
) {
  const found =
    findLatestPlayerSwitchEvent(
      root,
      detail
    );

  if (!found) {
    return false;
  }

  const nextKey =
    activePlayerIdentityKey(
      found.member
    );

  if (!nextKey) {
    return false;
  }

  const previousKey =
    activePlayerSwitchEventKey;

  const previousSlot =
    activePlayerSwitchEventSlot;

  activePlayerSwitchEventKey =
    nextKey;

  activePlayerSwitchEventSlot =
    found.slot;

  activePlayerSwitchEventUpdatedAt =
    Date.now();

  // Reinforce the pre-existing prompt lock with the same identity.
  activePlayerDomLockedKey =
    nextKey;

  activePlayerDomConfirmedAt =
    Date.now();

  const changed =
    setActivePlayerPokemon(
      found.member,
      'battle-switch-event'
    );

  activePlayerSwitchEventPokemon =
    activePlayerPokemon
      ? mergeTeamMember(
          found.member,
          activePlayerPokemon
        )
      : found.member;

  return (
    changed ||
    previousKey !== nextKey ||
    previousSlot !== found.slot
  );
}

function activePlayerIdentityKey(member) {
  if (!member?.name) {
    return null;
  }

  return [
    normalizeKey(member.name),
    Number.isFinite(member.level)
      ? member.level
      : ''
  ].join('|');
}


function lockedActivePlayerTeamMember() {
  if (!activePlayerDomLockedKey) {
    return null;
  }

  const member = playerTeam.find(candidate =>
    activePlayerIdentityKey(candidate) ===
    activePlayerDomLockedKey
  );

  if (!member || member.fainted) {
    return null;
  }

  if (
    activePlayerPokemon &&
    samePlayerPokemon(
      activePlayerPokemon,
      member
    )
  ) {
    return mergeTeamMember(
      member,
      activePlayerPokemon
    );
  }

  return member;
}

function clearInvalidActivePromptLock() {
  if (!activePlayerDomLockedKey) {
    return false;
  }

  const member = playerTeam.find(candidate =>
    activePlayerIdentityKey(candidate) ===
    activePlayerDomLockedKey
  );

  if (member && !member.fainted) {
    return false;
  }

  activePlayerDomLockedKey = null;
  activePlayerDomConfirmedAt = 0;

  return true;
}

function setActivePlayerPokemon(
  member,
  source,
  options = {}
) {
  if (!member) return false;

  const teamMember =
    matchingPlayerTeamMember(member);

  const authoritativeMoves =
    options.authoritativeMoves === true &&
    Array.isArray(member.moves) &&
    member.moves.length > 0;

  let next =
    teamMember
      ? mergeTeamMember(
          teamMember,
          member
        )
      : member;

  if (authoritativeMoves) {
    next = withAuthoritativeTeamMoves(
      next,
      member.moves
    );
  }

  const explicitPrompt =
    String(source || '') ===
      'dom-prompt';

  const switchEventSource =
    String(source || '') ===
      'battle-switch-event';

  const nextKey =
    activePlayerIdentityKey(next);

  // The explicit prompt is allowed to announce the new Pokémon before
  // its network switch_in response arrives.
  if (
    explicitPrompt &&
    activePlayerSwitchEventKey &&
    nextKey &&
    nextKey !== activePlayerSwitchEventKey
  ) {
    activePlayerSwitchEventKey = null;
    activePlayerSwitchEventSlot = null;
    activePlayerSwitchEventPokemon = null;
    activePlayerSwitchEventUpdatedAt = 0;
  }

  const visibleSwitch =
    (
      explicitPrompt ||
      switchEventSource
    ) &&
    activePlayerPokemon &&
    !samePlayerPokemon(
      activePlayerPokemon,
      next
    );

  if (visibleSwitch) {
    activePlayerPokemon = null;
  }

  if (
    activePlayerPokemon &&
    samePlayerPokemon(
      activePlayerPokemon,
      next
    )
  ) {
    next = mergeTeamMember(
      activePlayerPokemon,
      next
    );

    if (authoritativeMoves) {
      next = withAuthoritativeTeamMoves(
        next,
        member.moves
      );
    }
  }

  const changed =
    activePlayerSignature(next) !==
    activePlayerSignature(
      activePlayerPokemon
    );

  activePlayerPokemon = next;
  activePlayerPokemonSource =
    source || 'unknown';
  activePlayerPokemonUpdatedAt =
    Date.now();

  if (explicitPrompt && nextKey) {
    activePlayerDomConfirmedAt =
      Date.now();

    activePlayerDomLockedKey =
      nextKey;
  } else if (
    activePlayerDomLockedKey &&
    nextKey === activePlayerDomLockedKey &&
    String(source || '')
      .startsWith('dom-')
  ) {
    activePlayerDomConfirmedAt =
      Date.now();
  }

  if (
    activePlayerSwitchEventKey &&
    nextKey === activePlayerSwitchEventKey
  ) {
    activePlayerSwitchEventPokemon =
      activePlayerSwitchEventPokemon
        ? mergeTeamMember(
            activePlayerSwitchEventPokemon,
            next
          )
        : next;

    if (authoritativeMoves) {
      activePlayerSwitchEventPokemon =
        withAuthoritativeTeamMoves(
          activePlayerSwitchEventPokemon,
          member.moves
        );
    }

    activePlayerSwitchEventUpdatedAt =
      Date.now();
  }

  return changed;
}

function syncActivePlayerFromBattleDom() {
  const found =
    findActivePlayerFromVisibleMoves();

  if (!found) {
    return false;
  }

  const changed =
    setActivePlayerPokemon(
      found.member,
      found.source ||
      'dom-visible-moves'
    );

  if (changed && activeEncounter) {
    refreshKoForecast();
  }

  return changed;
}


function syncEncounterModeFromBattleDom() {
  if (
    !activeEncounter?.snapshot ||
    !visibleWildBattleEvidence()
  ) {
    return false;
  }

  if (
    activeEncounter.mode === 'wild' &&
    activeEncounter.captureEligible
  ) {
    if (
      !body?.querySelector(
        '#ih-capture-forecast'
      )
    ) {
      refreshCaptureForecast();
    }

    return false;
  }

  const candidate =
    activeEncounter.snapshot.candidate;

  const detail =
    activeEncounter.snapshot.detail;

  renderEncounter(
    candidate,
    detail
  );

  return true;
}

function scheduleActivePlayerDomSync(
  delay = 35
) {
  if (activePlayerDomSyncTimer) {
    clearTimeout(activePlayerDomSyncTimer);
  }

  activePlayerDomSyncTimer = setTimeout(
    () => {
      activePlayerDomSyncTimer = null;
      syncActivePlayerFromBattleDom();
    },
    delay
  );
}

function startActivePlayerDomObserver() {
  if (
    activePlayerDomObserver ||
    !document.documentElement
  ) {
    return;
  }

  activePlayerDomObserver =
    new MutationObserver(() => {
      if (activeEncounter) {
        syncEncounterModeFromBattleDom();
        scheduleActivePlayerDomSync(20);
      }
    });

  activePlayerDomObserver.observe(
    document.documentElement,
    {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'class',
        'style',
        'hidden',
        'aria-hidden',
        'aria-label',
        'title',
        'data-move',
        'data-move-name',
        'data-attack',
        'data-attack-name'
      ]
    }
  );
}

function updateActivePlayerPokemon(
  root,
  detail
) {
  clearInvalidActivePromptLock();

  const found =
    findBestActivePlayerPokemon(
      root,
      detail
    );

  if (!found) {
    // Never clear an active switch-event identity because a later payload
    // lacks a recognizable player Pokémon.
    if (activePlayerSwitchEventKey) {
      return false;
    }

    if (
      playerTeam.length &&
      activePlayerPokemon &&
      !matchingPlayerTeamMember(
        activePlayerPokemon
      )
    ) {
      activePlayerPokemon = null;
      activePlayerPokemonSource = null;
      activePlayerPokemonUpdatedAt = 0;
      return true;
    }

    return false;
  }

  const foundKey =
    activePlayerIdentityKey(
      found.member
    );

  const authoritativeKey =
    activePlayerSwitchEventKey ||
    activePlayerDomLockedKey;

  if (
    authoritativeKey &&
    foundKey &&
    foundKey !== authoritativeKey
  ) {
    return false;
  }

  return setActivePlayerPokemon(
    found.member,
    'payload'
  );
}


// InfinityMMO v2 battle responses expose the real player battler in:
//   state.you.active -> exact party slot
//   state.you.mon    -> exact Pokémon currently on the field
//   next.allowed.moves -> exact move buttons/PP for that same battler
// Battle-start packets do not need to contain a switch_in event, so this
// server state must outrank party order, DOM text and old battle locks.
function infinityBattleV2Packet(
  root,
  detail
) {
  if (!root || typeof root !== 'object') {
    return null;
  }

  const url = String(
    detail?.meta?.url || ''
  );

  const endpointMatch = url.match(
    /\/api\/battle\/v2\/(start|action|replace|optional-switch)(?:[?#]|$)/i
  );

  if (!endpointMatch) {
    return null;
  }

  const state = root.state;
  const you = state?.you;
  const mon = you?.mon;

  if (
    !state ||
    typeof state !== 'object' ||
    !you ||
    typeof you !== 'object' ||
    !mon ||
    typeof mon !== 'object'
  ) {
    return null;
  }

  const next =
    root.next &&
    typeof root.next === 'object'
      ? root.next
      : {};

  const terminal =
    state.over === true ||
    normalizeKey(next.phase || '') === 'over' ||
    terminalBattleOutcome(
      next.outcome ||
      state.outcome
    );

  if (terminal) {
    return null;
  }

  const slot = numberInRange(
    you.active,
    0,
    5
  );

  if (slot === null) {
    return null;
  }

  const allowed =
    next.allowed &&
    typeof next.allowed === 'object' &&
    !Array.isArray(next.allowed)
      ? next.allowed
      : {};

  const rawMoves = Array.isArray(
    allowed.moves
  )
    ? allowed.moves
    : [];

  const moveObjects = rawMoves
    .slice(0, 4)
    .map(move => {
      if (
        !move ||
        typeof move !== 'object'
      ) {
        return move;
      }

      return {
        ...move,
        currentPp:
          numberInRange(
            move.pp ??
            move.currentPp ??
            move.current_pp,
            0,
            99
          )
      };
    });

  let member = buildPlayerTeamMember(
    {
      ...mon,
      moves: moveObjects
    },
    '$.state.you.mon',
    detail,
    slot
  );

  if (!member?.name) {
    return null;
  }

  const exactSlotMember =
    playerTeam.find(candidate =>
      candidate.order === slot &&
      samePlayerPokemon(
        candidate,
        member
      )
    ) || null;

  if (exactSlotMember) {
    member = mergeTeamMember(
      exactSlotMember,
      member
    );
  }

  const exactMoves = moveObjects
    .map(extractTeamMoveRecord)
    .filter(Boolean)
    .slice(0, 4);

  const hasAuthoritativeMoves =
    exactMoves.length > 0;

  member = hydrateMemberDetailsFromCache({
    ...member,
    order: slot,
    active: true,
    moves:
      hasAuthoritativeMoves
        ? exactMoves
        : member.moves
  });

  // Hydration may bring useful stats from an older character snapshot.
  // Reapply the live battle move buttons afterwards so a replaced move
  // cannot be overwritten by the persistent cache.
  if (hasAuthoritativeMoves) {
    member = withAuthoritativeTeamMoves(
      member,
      exactMoves
    );
  }

  return {
    endpoint:
      endpointMatch[1].toLowerCase(),
    battleId:
      typeof root.battleId === 'string'
        ? root.battleId
        : null,
    slot,
    member,
    hasAuthoritativeMoves
  };
}

function updateActivePlayerFromInfinityBattleState(
  root,
  detail
) {
  const packet = infinityBattleV2Packet(
    root,
    detail
  );

  if (!packet) {
    return false;
  }

  // A valid /start response is an unconditional new-battle boundary.
  // Remove the previous battle's Gengar/Gyarados lock before adopting
  // the exact state returned by the server.
  if (packet.endpoint === 'start') {
    clearActiveBattleAuthority();
    clearActivePlayerForPartyLayoutChange();

    if (endConfirmationTimer) {
      clearTimeout(endConfirmationTimer);
      endConfirmationTimer = null;
    }
  }

  const key = activePlayerIdentityKey(
    packet.member
  );

  if (!key) {
    return false;
  }

  const previousKey =
    activePlayerSwitchEventKey;

  const previousSlot =
    activePlayerSwitchEventSlot;

  const teamIndex = playerTeam.findIndex(
    candidate =>
      candidate.order === packet.slot
  );

  if (teamIndex >= 0) {
    playerTeam = playerTeam.map(
      (candidate, index) => {
        const active =
          candidate.order ===
          packet.slot;

        if (index === teamIndex) {
          const merged =
            mergeTeamMember(
              candidate,
              packet.member
            );

          return {
            ...(
              packet.hasAuthoritativeMoves
                ? withAuthoritativeTeamMoves(
                    merged,
                    packet.member.moves
                  )
                : merged
            ),
            active
          };
        }

        return {
          ...candidate,
          active
        };
      }
    );
  }

  rememberMemberMoves(
    packet.member
  );

  activePlayerSwitchEventKey = key;
  activePlayerSwitchEventSlot =
    packet.slot;
  activePlayerSwitchEventPokemon =
    packet.member;
  activePlayerSwitchEventUpdatedAt =
    Date.now();

  activePlayerDomLockedKey = key;
  activePlayerDomConfirmedAt =
    Date.now();

  activeBattleAuthorityEstablished = true;
  activeBattleAuthoritySlot = packet.slot;
  activeBattleAuthorityUpdatedAt = Date.now();

  const changed = setActivePlayerPokemon(
    packet.member,
    'battle-authoritative-state',
    {
      authoritativeMoves:
        packet.hasAuthoritativeMoves
    }
  );

  activePlayerSwitchEventPokemon =
    activePlayerPokemon
      ? mergeTeamMember(
          packet.member,
          activePlayerPokemon
        )
      : packet.member;

  if (packet.hasAuthoritativeMoves) {
    activePlayerSwitchEventPokemon =
      withAuthoritativeTeamMoves(
        activePlayerSwitchEventPokemon,
        packet.member.moves
      );
  }

  return (
    changed ||
    previousKey !== key ||
    previousSlot !== packet.slot
  );
}


// InfinityMMO battle v2 responses expose the live opponent in:
//   state.foe.active -> active opponent slot
//   state.foe.mon.hp -> current HP
//   state.foe.mon.maxHp -> maximum HP
// Rich opponent records such as $.foe may contain full stats and can be
// selected for IV rendering, but they must never override this live HP.
function infinityBattleV2OpponentPacket(
  root,
  detail
) {
  if (!root || typeof root !== 'object') {
    return null;
  }

  const url = String(
    detail?.meta?.url || ''
  );

  const endpointMatch = url.match(
    /\/api\/battle\/v2\/(start|action|replace|optional-switch)(?:[?#]|$)/i
  );

  if (!endpointMatch) {
    return null;
  }

  const state = root.state;
  const foe = state?.foe;
  const mon = foe?.mon;

  if (
    !state ||
    typeof state !== 'object' ||
    !foe ||
    typeof foe !== 'object' ||
    !mon ||
    typeof mon !== 'object'
  ) {
    return null;
  }

  const next =
    root.next &&
    typeof root.next === 'object'
      ? root.next
      : {};

  const terminal =
    state.over === true ||
    normalizeKey(next.phase || '') === 'over' ||
    terminalBattleOutcome(
      next.outcome ||
      state.outcome
    );

  if (terminal) {
    return {
      terminal: true,
      endpoint:
        endpointMatch[1].toLowerCase()
    };
  }

  const hp = numberInRange(
    mon.hp ??
    mon.currentHp ??
    mon.current_hp,
    0,
    99999
  );

  if (hp === null) {
    return null;
  }

  const maxHp = numberInRange(
    mon.maxHp ??
    mon.max_hp ??
    mon.hpMax ??
    mon.hp_max,
    1,
    99999
  );

  return {
    terminal: false,
    endpoint:
      endpointMatch[1].toLowerCase(),
    battleId:
      typeof root.battleId === 'string'
        ? root.battleId
        : null,
    slot: numberInRange(
      foe.active,
      0,
      99
    ),
    name:
      mon.name ||
      mon.species ||
      null,
    species:
      mon.species ||
      mon.name ||
      null,
    hp,
    maxHp,
    bossBars: numberInRange(
      mon.bossBars ??
      mon.boss_bars,
      0,
      99
    ),
    bossBarsLeft: numberInRange(
      mon.bossBarsLeft ??
      mon.boss_bars_left,
      0,
      99
    ),
    updatedAt: Date.now()
  };
}

function updateActiveOpponentFromInfinityBattleState(
  root,
  detail
) {
  const packet =
    infinityBattleV2OpponentPacket(
      root,
      detail
    );

  if (!packet) {
    return false;
  }

  if (
    packet.endpoint === 'start' ||
    packet.terminal
  ) {
    clearActiveOpponentBattleState();
  }

  if (packet.terminal) {
    return true;
  }

  const previous =
    activeOpponentBattleState;

  activeOpponentBattleState = {
    ...packet,
    battleId:
      packet.battleId ||
      previous?.battleId ||
      null
  };

  return (
    !previous ||
    normalizeKey(previous.name || previous.species) !==
      normalizeKey(packet.name || packet.species) ||
    previous.slot !== packet.slot ||
    previous.hp !== packet.hp ||
    previous.maxHp !== packet.maxHp ||
    previous.bossBars !== packet.bossBars ||
    previous.bossBarsLeft !== packet.bossBarsLeft ||
    previous.battleId !==
      activeOpponentBattleState.battleId
  );
}


// NPC battles with more than one opponent may advance through
// /api/battle/v2/optional-switch. Those packets contain the new foe in
// state.foe.mon and the player's live buttons in next.allowed.moves, but
// usually omit the rich top-level foe/foeParty records.
//
// The initial /start response already cached the complete NPC roster.
// Whenever state.foe.mon changes, use that server-confirmed identity and
// hydrate it from the cached roster before rendering. This changes only the
// opponent card; it does not guess from DOM text or party order.
function syncActiveNpcOpponentFromInfinityBattleState(
  root,
  detail
) {
  if (activeEncounter?.mode !== 'npc') {
    return false;
  }

  const packet =
    infinityBattleV2OpponentPacket(
      root,
      detail
    );

  if (
    !packet ||
    packet.terminal ||
    !root?.state?.foe?.mon ||
    typeof root.state.foe.mon !== 'object'
  ) {
    return false;
  }

  const candidate = {
    object: root.state.foe.mon,
    path: '$.state.foe.mon',
    score: Number.MAX_SAFE_INTEGER
  };

  const nextSnapshot =
    prepareEncounterSnapshot(
      candidate,
      detail,
      'npc',
      activeEncounter
        ?.snapshot
        ?.trainerName ||
      findNpcTrainerName(root) ||
      null
    );

  if (
    sameEncounterPokemon(
      activeEncounter.snapshot,
      nextSnapshot
    )
  ) {
    return false;
  }

  renderNpcEncounter(
    candidate,
    detail,
    activeEncounter
      ?.snapshot
      ?.trainerName ||
    findNpcTrainerName(root) ||
    null
  );

  return true;
}



function authoritativeOpponentBossBarState(
  snapshot
) {
  const live =
    activeOpponentBattleState;

  if (!live) {
    return null;
  }

  const snapshotName = normalizeKey(
    snapshot?.meta?.name || ''
  );

  const liveKeys = new Set(
    [live.name, live.species]
      .map(normalizeKey)
      .filter(Boolean)
  );

  // Never use bar counters belonging to the previous NPC Pokémon.
  if (
    snapshotName &&
    liveKeys.size &&
    !liveKeys.has(snapshotName)
  ) {
    return null;
  }

  const total = numberInRange(
    live.bossBars,
    0,
    99
  );

  const left = numberInRange(
    live.bossBarsLeft,
    0,
    99
  );

  if (
    total === null &&
    left === null
  ) {
    return null;
  }

  const resolvedTotal =
    total ?? left ?? 0;

  const resolvedLeft =
    left ?? resolvedTotal;

  return {
    total: resolvedTotal,
    left: resolvedLeft,

    // InfinityMMO counts the current bar in bossBarsLeft.
    // Real diagnostic: 3 -> boss_break_bar -> 2.
    // Therefore a lethal hit with left > 1 removes one bar,
    // but does not defeat the opponent.
    hasExtraBars:
      resolvedLeft > 1
  };
}


function authoritativeOpponentCurrentHp(
  snapshot
) {
  const live =
    activeOpponentBattleState;

  if (
    !live ||
    !Number.isFinite(live.hp)
  ) {
    return null;
  }

  const snapshotName = normalizeKey(
    snapshot?.meta?.name || ''
  );

  const liveKeys = new Set(
    [live.name, live.species]
      .map(normalizeKey)
      .filter(Boolean)
  );

  // Reject stale HP from another foe after an NPC/trainer switch.
  if (
    snapshotName &&
    liveKeys.size &&
    !liveKeys.has(snapshotName)
  ) {
    return null;
  }

  return numberInRange(
    live.hp,
    0,
    99999
  );
}

const KO_RANDOM_ROLLS = Object.freeze(
  Array.from(
    { length: 16 },
    (_, index) =>
      (85 + index) / 100
  )
);

const KO_FIXED_TWO_HIT_MOVES = new Set([
  'bonemerang',
  'doublehit',
  'doubleironbash',
  'doublekick',
  'dragondarts',
  'dualslice',
  'geargrind',
  'twindle',
  'twineedle'
]);

const KO_VARIABLE_MULTI_HIT_MOVES = new Set([
  'armthrust',
  'barrage',
  'bone rush',
  'bonerush',
  'bulletseed',
  'cometpunch',
  'doubleslap',
  'furyattack',
  'furyswipes',
  'iciclespear',
  'pinmissile',
  'rockblast',
  'scale shot',
  'scaleshot',
  'spikecannon',
  'tailslap',
  'watershuriken'
]);

const KO_VARIABLE_DAMAGE_MOVES = new Set([
  'bide',
  'counter',
  'endeavor',
  'flail',
  'frustration',
  'grassknot',
  'gyroball',
  'heavyslam',
  'lowkick',
  'magnitude',
  'metalburst',
  'mirrorcoat',
  'naturalgift',
  'present',
  'psywave',
  'return',
  'reversal',
  'storedpower',
  'trumpcard',
  'wringout'
]);

const KO_OHKO_MOVES = new Set([
  'fissure',
  'guillotine',
  'horndrill',
  'sheercold'
]);

function koMoveKey(move) {
  return normalizeKey(
    move?.identifier ||
    move?.name ||
    ''
  );
}

function koPokemonSpeciesKey(value) {
  return normalizeKey(
    value?.species ||
    value?.meta?.species ||
    value?.meta?.name ||
    value?.name ||
    ''
  );
}

function koItemSpeciesMatches(
  rule,
  pokemon
) {
  if (!rule) return false;

  const species =
    koPokemonSpeciesKey(pokemon);

  if (!species) return false;

  if (
    Array.isArray(rule.species) &&
    rule.species.length &&
    !rule.species
      .map(normalizeKey)
      .includes(species)
  ) {
    return false;
  }

  if (
    rule.requiresNotFullyEvolved === true &&
    !ITEM_NFE_SPECIES.has(species)
  ) {
    return false;
  }

  return true;
}

function koItemMoveMatches(
  rule,
  move,
  typeMultiplier = 1
) {
  if (!rule || !move) return false;

  if (
    Array.isArray(rule.damageClasses) &&
    rule.damageClasses.length &&
    !rule.damageClasses.includes(
      move.damageClass
    )
  ) {
    return false;
  }

  if (
    Array.isArray(rule.moveTypes) &&
    rule.moveTypes.length &&
    !rule.moveTypes.includes(move.type)
  ) {
    return false;
  }

  if (
    rule.superEffectiveOnly === true &&
    !(typeMultiplier > 1)
  ) {
    return false;
  }

  return true;
}

function koItemEffectRecord(
  itemValue,
  ruleName
) {
  const entry = itemDataEntry(itemValue);
  const rule =
    entry?.mechanics?.[ruleName];

  if (!entry || !rule) return null;

  return {
    entry,
    rule
  };
}

function koAttackerItemStatEffect(
  member,
  move
) {
  const effect =
    koItemEffectRecord(
      member?.heldItem,
      'attackStat'
    );

  if (!effect) return null;

  if (
    !koItemMoveMatches(
      effect.rule,
      move
    ) ||
    !koItemSpeciesMatches(
      effect.rule,
      member
    )
  ) {
    return null;
  }

  return {
    entry: effect.entry,
    multiplier:
      effect.rule.multiplier
  };
}

function koAttackerItemDamageEffect(
  member,
  move,
  typeMultiplier
) {
  const effect =
    koItemEffectRecord(
      member?.heldItem,
      'damage'
    );

  if (!effect) return null;

  if (
    !koItemMoveMatches(
      effect.rule,
      move,
      typeMultiplier
    )
  ) {
    return null;
  }

  return {
    entry: effect.entry,
    multiplier:
      effect.rule.multiplier,
    consumedOnUse:
      effect.rule.consumedOnUse === true
  };
}

function koDefenderItemStatEffect(
  snapshot,
  move
) {
  const effect =
    koItemEffectRecord(
      snapshot?.meta?.heldItem,
      'defenseStat'
    );

  if (!effect) return null;

  if (
    !koItemMoveMatches(
      effect.rule,
      move
    ) ||
    !koItemSpeciesMatches(
      effect.rule,
      snapshot
    )
  ) {
    return null;
  }

  return {
    entry: effect.entry,
    multiplier:
      effect.rule.multiplier
  };
}

function koDefenderAccuracyItemEffect(
  snapshot,
  move
) {
  if (
    !Number.isFinite(move?.accuracy)
  ) {
    return null;
  }

  const entry =
    itemDataEntry(
      snapshot?.meta?.heldItem
    );

  const multiplier =
    Number(
      entry?.mechanics
        ?.incomingAccuracyMultiplier
    );

  if (
    !entry ||
    !Number.isFinite(multiplier) ||
    multiplier <= 0
  ) {
    return null;
  }

  return {
    entry,
    multiplier,
    effectiveAccuracy:
      Math.max(
        1,
        Math.min(
          100,
          Math.round(
            move.accuracy *
            multiplier *
            10
          ) / 10
        )
      )
  };
}

function koDefenderSurvivalItemEffect(
  snapshot,
  targetHp,
  minHits = 1,
  maxHits = 1
) {
  const entry =
    itemDataEntry(
      snapshot?.meta?.heldItem
    );

  const rule =
    entry?.mechanics?.survival;

  if (!entry || !rule) {
    return null;
  }

  const maxHp =
    numberInRange(
      snapshot?.stats?.hp,
      1,
      99999
    );

  const atFullHp =
    targetHp !== null &&
    maxHp !== null &&
    targetHp >= maxHp;

  if (
    rule.fullHpRequired === true &&
    !atFullHp
  ) {
    return null;
  }

  if (
    rule.singleHitOnly === true &&
    (
      minHits !== 1 ||
      maxHits !== 1
    )
  ) {
    return null;
  }

  return {
    entry,
    kind: rule.kind,
    chance:
      Number.isFinite(rule.chance)
        ? rule.chance
        : null,
    surviveHp:
      rule.surviveHp ?? 1,
    atFullHp
  };
}

function formatKoItemMultiplier(value) {
  return formatMultiplier(
    Number(value) || 1
  );
}

function extractOpponentCurrentHp(
  object,
  stats
) {
  if (!object || typeof object !== 'object') {
    return null;
  }

  const direct = numberInRange(
    getByAliases(object, [
      'currentHp',
      'current_hp',
      'hpCurrent',
      'hp_current',
      'remainingHp',
      'remaining_hp',
      'battleHp',
      'battle_hp',
      'healthCurrent',
      'health_current'
    ]),
    0,
    99999
  );

  if (direct !== null) {
    return direct;
  }

  const hpObject = getByAliases(object, [
    'hp',
    'health'
  ]);

  if (hpObject && typeof hpObject === 'object') {
    const nested = numberInRange(
      getByAliases(hpObject, [
        'current',
        'value',
        'remaining',
        'now'
      ]),
      0,
      99999
    );

    if (nested !== null) {
      return nested;
    }
  }

  const maxHp = numberInRange(
    getByAliases(object, [
      'maxHp',
      'max_hp',
      'hpMax',
      'hp_max',
      'maximumHp',
      'maximum_hp'
    ]),
    1,
    99999
  ) ?? numberInRange(
    stats?.hp,
    1,
    99999
  );

  const plainHp = numberInRange(
    getByAliases(object, [
      'hp',
      'health'
    ]),
    0,
    99999
  );

  if (
    plainHp !== null &&
    (
      maxHp === null ||
      plainHp <= maxHp
    )
  ) {
    return plainHp;
  }

  const percentage = numberInRange(
    getByAliases(object, [
      'hpPercent',
      'hp_percent',
      'healthPercent',
      'health_percent'
    ]),
    0,
    100
  );

  if (
    percentage !== null &&
    maxHp !== null
  ) {
    return Math.max(
      0,
      Math.round(
        maxHp *
        percentage /
        100
      )
    );
  }

  return null;
}

function activeAttackingStat(
  member,
  move,
  itemEffect = null
) {
  const key =
    move.damageClass === 'special'
      ? 'spa'
      : 'atk';

  let value = numberInRange(
    member?.stats?.[key],
    1,
    99999
  );

  if (
    value !== null &&
    itemEffect &&
    Number.isFinite(
      itemEffect.multiplier
    )
  ) {
    value = Math.max(
      1,
      Math.floor(
        value *
        itemEffect.multiplier
      )
    );
  }

  return value;
}

function opponentDefendingStat(
  snapshot,
  move,
  itemEffect = null
) {
  const key =
    move.damageClass === 'special'
      ? 'spd'
      : 'def';

  let value = numberInRange(
    snapshot?.stats?.[key],
    1,
    99999
  );

  if (value === null) {
    return null;
  }

  const ability = normalizeKey(
    snapshot?.meta?.ability || ''
  );

  if (
    key === 'def' &&
    ability === 'furcoat'
  ) {
    value *= 2;
  }

  if (
    key === 'spd' &&
    ability === 'icescales'
  ) {
    value *= 2;
  }

  if (
    itemEffect &&
    Number.isFinite(
      itemEffect.multiplier
    )
  ) {
    value = Math.max(
      1,
      Math.floor(
        value *
        itemEffect.multiplier
      )
    );
  }

  return value;
}

function koStabMultiplier(
  member,
  move
) {
  if (!member.types.includes(move.type)) {
    return 1;
  }

  return normalizeKey(
    member.ability || ''
  ) === 'adaptability'
    ? 2
    : 1.5;
}

function koAttackerModifier(
  member,
  move
) {
  const ability = normalizeKey(
    member.ability || ''
  );

  let modifier = 1;

  if (
    move.damageClass === 'physical' &&
    (
      ability === 'hugepower' ||
      ability === 'purepower'
    )
  ) {
    modifier *= 2;
  }

  if (
    move.damageClass === 'physical' &&
    (
      ability === 'hustle' ||
      ability === 'gorillatactics'
    )
  ) {
    modifier *= 1.5;
  }

  if (
    ability === 'technician' &&
    Number.isFinite(move.power) &&
    move.power <= 60
  ) {
    modifier *= 1.5;
  }

  const hpCurrent = member.hp?.current;
  const hpMaximum = member.hp?.maximum;
  const lowHp =
    Number.isFinite(hpCurrent) &&
    Number.isFinite(hpMaximum) &&
    hpMaximum > 0 &&
    hpCurrent <= hpMaximum / 3;

  if (lowHp) {
    if (
      ability === 'blaze' &&
      move.type === 'fire'
    ) {
      modifier *= 1.5;
    }

    if (
      ability === 'torrent' &&
      move.type === 'water'
    ) {
      modifier *= 1.5;
    }

    if (
      ability === 'overgrow' &&
      move.type === 'grass'
    ) {
      modifier *= 1.5;
    }

    if (
      ability === 'swarm' &&
      move.type === 'bug'
    ) {
      modifier *= 1.5;
    }
  }

  return modifier;
}

function koDefenderModifier(
  snapshot,
  currentHp,
  typeMultiplier
) {
  const ability = normalizeKey(
    snapshot?.meta?.ability || ''
  );

  let modifier = 1;

  if (
    typeMultiplier > 1 &&
    (
      ability === 'filter' ||
      ability === 'solidrock' ||
      ability === 'prismarmor'
    )
  ) {
    modifier *= 0.75;
  }

  const maxHp = numberInRange(
    snapshot?.stats?.hp,
    1,
    99999
  );

  if (
    maxHp !== null &&
    currentHp !== null &&
    currentHp >= maxHp &&
    (
      ability === 'multiscale' ||
      ability === 'shadowshield'
    )
  ) {
    modifier *= 0.5;
  }

  return modifier;
}

function koBaseDamage(
  level,
  power,
  attack,
  defense
) {
  const levelFactor =
    Math.floor((2 * level) / 5) + 2;

  const scaled = Math.floor(
    (
      levelFactor *
      power *
      attack
    ) / defense
  );

  return Math.floor(scaled / 50) + 2;
}

function koDamageRolls(
  base,
  modifier
) {
  if (modifier === 0) {
    return KO_RANDOM_ROLLS.map(() => 0);
  }

  return KO_RANDOM_ROLLS.map(random =>
    Math.max(
      1,
      Math.floor(
        base *
        modifier *
        random
      )
    )
  );
}

function fixedKoDamage(
  member,
  move,
  targetHp,
  typeMultiplier
) {
  const key = koMoveKey(move);
  let amount = null;
  let note = null;

  if (
    key === 'nightshade' ||
    key === 'seismictoss'
  ) {
    amount = member.level;
    note = 'dano fixo pelo nível';
  } else if (key === 'dragonrage') {
    amount = 40;
    note = 'dano fixo';
  } else if (key === 'sonicboom') {
    amount = 20;
    note = 'dano fixo';
  } else if (
    key === 'superfang' ||
    key === 'naturesmadness' ||
    key === 'ruination'
  ) {
    if (targetHp === null) {
      return {
        kind: 'missing',
        reason: 'HP atual do alvo indisponível'
      };
    }

    amount = Math.max(
      1,
      Math.floor(targetHp / 2)
    );
    note = 'metade do HP atual';
  } else if (key === 'finalgambit') {
    amount = member.hp?.current;
    note = 'usa o HP atual do atacante';
  } else {
    return null;
  }

  if (!Number.isFinite(amount)) {
    return {
      kind: 'missing',
      reason: 'dado necessário indisponível'
    };
  }

  if (typeMultiplier === 0) {
    amount = 0;
  }

  return {
    kind: 'fixed',
    min: amount,
    max: amount,
    typeMultiplier,
    note
  };
}

function calculateKoEstimate(
  member,
  move,
  snapshot
) {
  const targetHp =
    authoritativeOpponentCurrentHp(
      snapshot
    ) ??
    extractOpponentCurrentHp(
      snapshot?.candidate?.object,
      snapshot?.stats
    );

  const typeMultiplier =
    abilityAdjustedAttackMultiplier(
      move.type,
      snapshot?.meta?.types || [],
      snapshot?.meta?.ability
    );

  const attackerItem =
    itemDataEntry(member?.heldItem);

  const defenderItem =
    itemDataEntry(
      snapshot?.meta?.heldItem
    );

  const accuracyItemEffect =
    koDefenderAccuracyItemEffect(
      snapshot,
      move
    );

  const baseContext = {
    move,
    typeMultiplier,
    targetHp,
    attackerItem,
    defenderItem,
    accuracyItemEffect
  };

  if (move.currentPp === 0) {
    return {
      ...baseContext,
      kind: 'no-pp'
    };
  }

  if (
    move.damageClass === 'status' ||
    !move.type
  ) {
    return {
      ...baseContext,
      kind: 'status'
    };
  }

  const key = koMoveKey(move);

  if (KO_OHKO_MOVES.has(key)) {
    return {
      ...baseContext,
      kind: 'ohko',
      survivalItemEffect:
        koDefenderSurvivalItemEffect(
          snapshot,
          targetHp,
          1,
          1
        )
    };
  }

  const fixed =
    fixedKoDamage(
      member,
      move,
      targetHp,
      typeMultiplier
    );

  if (fixed) {
    return {
      ...baseContext,
      ...fixed,
      survivalItemEffect:
        koDefenderSurvivalItemEffect(
          snapshot,
          targetHp,
          1,
          1
        )
    };
  }

  if (
    KO_VARIABLE_DAMAGE_MOVES.has(key) ||
    !Number.isFinite(move.power) ||
    move.power <= 0
  ) {
    return {
      ...baseContext,
      kind: 'variable'
    };
  }

  const level = numberInRange(
    member.level,
    1,
    999
  );

  const attackerStatItemEffect =
    koAttackerItemStatEffect(
      member,
      move
    );

  const defenderStatItemEffect =
    koDefenderItemStatEffect(
      snapshot,
      move
    );

  const attackerDamageItemEffect =
    koAttackerItemDamageEffect(
      member,
      move,
      typeMultiplier
    );

  const attack =
    activeAttackingStat(
      member,
      move,
      attackerStatItemEffect
    );

  const defense =
    opponentDefendingStat(
      snapshot,
      move,
      defenderStatItemEffect
    );

  if (
    level === null ||
    attack === null ||
    defense === null
  ) {
    return {
      ...baseContext,
      kind: 'missing',
      attackerStatItemEffect,
      defenderStatItemEffect,
      attackerDamageItemEffect,
      reason:
        level === null
          ? 'nível indisponível'
          : attack === null
            ? 'stat ofensivo indisponível'
            : 'defesa do alvo indisponível'
    };
  }

  const base = koBaseDamage(
    level,
    move.power,
    attack,
    defense
  );

  const commonModifier =
    koStabMultiplier(member, move) *
    typeMultiplier *
    koAttackerModifier(member, move) *
    (
      attackerDamageItemEffect
        ?.multiplier || 1
    ) *
    koDefenderModifier(
      snapshot,
      targetHp,
      typeMultiplier
    );

  let minHits = 1;
  let maxHits = 1;

  if (KO_FIXED_TWO_HIT_MOVES.has(key)) {
    minHits = 2;
    maxHits = 2;
  } else if (
    KO_VARIABLE_MULTI_HIT_MOVES.has(key)
  ) {
    minHits = 2;
    maxHits = 5;
  } else if (key === 'surgingstrikes') {
    minHits = 3;
    maxHits = 3;
  }

  const rolls =
    koDamageRolls(
      base,
      commonModifier
    );

  return {
    ...baseContext,
    kind: 'damage',
    attackerStatItemEffect,
    attackerDamageItemEffect,
    defenderStatItemEffect,
    survivalItemEffect:
      koDefenderSurvivalItemEffect(
        snapshot,
        targetHp,
        minHits,
        maxHits
      ),
    stab:
      member.types.includes(move.type),
    min:
      Math.min(...rolls) *
      minHits,
    max:
      Math.max(...rolls) *
      maxHits,
    minHits,
    maxHits
  };
}

function classifyKoEstimate(estimate) {
  const bossBarState =
    authoritativeOpponentBossBarState(
      activeEncounter?.snapshot
    );

  const removesBossBar =
    bossBarState?.hasExtraBars === true;

  if (estimate.kind === 'status') {
    return {
      label: 'STATUS',
      className: 'ih-ko-status'
    };
  }

  if (estimate.kind === 'no-pp') {
    return {
      label: 'SEM PP',
      className: 'ih-ko-missing'
    };
  }

  const canReachKo =
    estimate.kind === 'ohko'
      ? estimate.typeMultiplier > 0
      : (
          estimate.targetHp !== null &&
          Number.isFinite(estimate.max) &&
          estimate.max >=
            estimate.targetHp
        );

  if (
    canReachKo &&
    estimate.survivalItemEffect
      ?.kind === 'focus-sash'
  ) {
    return {
      label: 'NÃO MATA · SASH',
      className: 'ih-ko-no'
    };
  }

  if (
    canReachKo &&
    estimate.survivalItemEffect
      ?.kind === 'focus-band'
  ) {
    return {
      label:
        (
          estimate.kind === 'ohko' ||
          (
            Number.isFinite(estimate.min) &&
            estimate.targetHp !== null &&
            estimate.min >=
              estimate.targetHp
          )
        )
          ? '90% DE MATAR'
          : 'CHANCE + BAND',
      className: 'ih-ko-chance'
    };
  }

  if (estimate.kind === 'ohko') {
    return {
      label:
        estimate.typeMultiplier === 0
          ? 'IMUNE'
          : (
              removesBossBar
                ? 'TIRA 1 BARRA SE ACERTAR'
                : 'MATA SE ACERTAR'
            ),
      className:
        estimate.typeMultiplier === 0
          ? 'ih-ko-immune'
          : 'ih-ko-chance'
    };
  }

  if (estimate.kind === 'variable') {
    return {
      label: 'DANO VARIÁVEL',
      className: 'ih-ko-variable'
    };
  }

  if (estimate.kind === 'missing') {
    return {
      label: 'SEM DADOS',
      className: 'ih-ko-missing'
    };
  }

  if (estimate.max === 0) {
    return {
      label: 'IMUNE',
      className: 'ih-ko-immune'
    };
  }

  if (
    estimate.targetHp === null ||
    estimate.targetHp <= 0
  ) {
    return {
      label: 'DANO',
      className: 'ih-ko-neutral'
    };
  }

  if (estimate.min >= estimate.targetHp) {
    return {
      label:
        removesBossBar
          ? 'TIRA 1 BARRA'
          : 'MATA',
      className: 'ih-ko-kill'
    };
  }

  if (estimate.max >= estimate.targetHp) {
    return {
      label:
        removesBossBar
          ? 'CHANCE DE TIRAR'
          : 'CHANCE',
      className: 'ih-ko-chance'
    };
  }

  return {
    label:
      removesBossBar
        ? 'NÃO TIRA BARRA'
        : 'NÃO MATA',
    className: 'ih-ko-no'
  };
}

function koMoveRowHtml(estimate) {
  const outcome =
    classifyKoEstimate(estimate);

  const bossBarState =
    authoritativeOpponentBossBarState(
      activeEncounter?.snapshot
    );

  const move = estimate.move;
  const typeLabel =
    TYPE_LABELS[move.type] ||
    move.type ||
    '—';

  let details = '';

  if (
    estimate.kind === 'damage' ||
    estimate.kind === 'fixed'
  ) {
    details = `
      <small>
        ${escapeHtml(
          `${estimate.min}–${estimate.max} de dano`
        )}
        ${
          estimate.targetHp !== null
            ? ` · alvo ${escapeHtml(estimate.targetHp)} HP`
            : ''
        }
        ${
          bossBarState?.hasExtraBars
            ? ` · ${escapeHtml(
                bossBarState.left
              )} barras`
            : ''
        }
      </small>
    `;
  } else if (estimate.kind === 'status') {
    details = `
      <small>Golpe de status, sem dano direto.</small>
    `;
  } else if (estimate.kind === 'missing') {
    details = `
      <small>${escapeHtml(estimate.reason || 'Dados insuficientes.')}</small>
    `;
  } else if (estimate.kind === 'variable') {
    details = `
      <small>O poder depende de uma condição especial.</small>
    `;
  } else if (estimate.kind === 'ohko') {
    details = `
      <small>Golpe de nocaute em um acerto, sujeito à precisão.</small>
    `;
  }

  const hits =
    estimate.minHits &&
    estimate.maxHits &&
    estimate.maxHits > 1
      ? (
          estimate.minHits === estimate.maxHits
            ? `${estimate.minHits} acertos`
            : `${estimate.minHits}–${estimate.maxHits} acertos`
        )
      : null;

  const itemEffectLabels = [];

  for (const effect of [
    estimate.attackerStatItemEffect,
    estimate.attackerDamageItemEffect
  ]) {
    if (!effect?.entry) continue;

    itemEffectLabels.push(
      `${effect.entry.name} ${formatKoItemMultiplier(
        effect.multiplier
      )}`
    );
  }

  if (
    estimate.defenderStatItemEffect
      ?.entry
  ) {
    itemEffectLabels.push(
      `ALVO ${estimate.defenderStatItemEffect.entry.name} ${formatKoItemMultiplier(
        estimate.defenderStatItemEffect.multiplier
      )}`
    );
  }

  if (
    estimate.accuracyItemEffect
      ?.entry
  ) {
    itemEffectLabels.push(
      `ACERTO ${estimate.accuracyItemEffect.effectiveAccuracy}% (${estimate.accuracyItemEffect.entry.name})`
    );
  }

  if (
    estimate.survivalItemEffect
      ?.entry
  ) {
    const survival =
      estimate.survivalItemEffect;

    itemEffectLabels.push(
      survival.kind === 'focus-sash'
        ? `${survival.entry.name}: 1 HP`
        : `${survival.entry.name}: 10% DE SOBREVIVER`
    );
  }

  return `
    <div class="ih-ko-row">
      <div class="ih-ko-move-copy">
        <strong>${escapeHtml(move.name)}</strong>

        <span>
          ${escapeHtml(typeLabel)}
          ${escapeHtml(
            formatMultiplier(
              estimate.typeMultiplier ?? 1
            )
          )}
          ${estimate.stab ? ' · STAB' : ''}
          ${hits ? ` · ${escapeHtml(hits)}` : ''}
          ${
            itemEffectLabels.length
              ? ` · ${escapeHtml(
                  itemEffectLabels.join(' · ')
                )}`
              : ''
          }
        </span>

        ${details}
      </div>

      <span class="ih-ko-badge ${outcome.className}">
        ${escapeHtml(outcome.label)}
      </span>
    </div>
  `;
}

function koForecastCardHtml() {
  const member =
    resolveActivePlayerTeamMember();

  if (!member) {
    return `
      <section
        id="ih-ko-forecast"
        class="ih-card ih-ko-card"
      >
        <h3>
          CHANCE DE MATAR
          <small>AGUARDANDO POKÉMON EM CAMPO</small>
        </h3>

        <p class="ih-ko-waiting">
          Aguardando o jogo identificar qual Pokémon seu está lutando.
        </p>
      </section>
    `;
  }

  const moves = (member.moves || [])
    .slice(0, 4);

  if (!moves.length) {
    return `
      <section
        id="ih-ko-forecast"
        class="ih-card ih-ko-card"
      >
        <h3>
          CHANCE DE MATAR
          <small>${escapeHtml(member.name)}</small>
        </h3>

        <p class="ih-ko-waiting">
          Aguardando os golpes do Pokémon em campo.
        </p>
      </section>
    `;
  }

  const estimates = moves.map(move =>
    calculateKoEstimate(
      member,
      move,
      activeEncounter.snapshot
    )
  );

  const bossBarState =
    authoritativeOpponentBossBarState(
      activeEncounter.snapshot
    );

  const hasExtraBossBars =
    bossBarState?.hasExtraBars === true;

  const realStats =
    Object.keys(member.stats || {}).length >= 4;

  const activeHeldItemName =
    heldItemDisplayName(
      member.heldItem
    );

  return `
    <section
      id="ih-ko-forecast"
      class="ih-card ih-ko-card"
    >
      <h3>
        ${
          hasExtraBossBars
            ? 'CHANCE DE TIRAR BARRA'
            : 'CHANCE DE MATAR'
        }
        <small>
          ${
            hasExtraBossBars
              ? `PREVISÃO DE BARRA · ${escapeHtml(
                  bossBarState.left
                )} RESTANTES`
              : 'PREVISÃO DE KO'
          }
        </small>
      </h3>

      <div class="ih-ko-active">
        <strong>${escapeHtml(member.name)}</strong>
        <span>
          ${
            member.level
              ? `Nível ${escapeHtml(member.level)} · `
              : ''
          }
          ${realStats ? 'Stats reais' : 'Stats incompletos'}
          ${
            activeHeldItemName
              ? ` · Item ${escapeHtml(
                  activeHeldItemName
                )}`
              : ''
          }
        </span>
      </div>

      <div class="ih-ko-list">
        ${estimates
          .map(koMoveRowHtml)
          .join('')}
      </div>

      <p class="ih-ko-disclaimer">
        Estimativa sem crítico, usando nível, poder, Atq/AtE,
        Def/DeE, STAB, tipo, habilidades e itens reconhecidos,
        com variação de 85%–100%. Itens seguem o padrão da
        geração usada pela base do jogo. Clima e estágios podem alterar.
        ${
          hasExtraBossBars
            ? ' O excesso de dano não passa para a próxima barra.'
            : ''
        }
      </p>
    </section>
  `;
}

function refreshKoForecast() {
  if (!body) return;

  body.querySelector(
    '#ih-ko-forecast'
  )?.remove();

  if (!activeEncounter?.snapshot) {
    return;
  }

  const source =
    body.querySelector('.ih-source');

  const html =
    koForecastCardHtml();

  if (source) {
    source.insertAdjacentHTML(
      'beforebegin',
      html
    );
  } else {
    body.insertAdjacentHTML(
      'beforeend',
      html
    );
  }

  prepareCollapsibleSections();
  enforceFixedPanelBlockOrder();

  if (knownTeamMoveCount() === 0) {
    scheduleMoveRescanLoop(
      'ko-zero-moves'
    );
  }
}


const CAPTURE_BALLS = Object.freeze([
  {
    key: 'poke',
    label: 'Poké',
    multiplier: 1
  },
  {
    key: 'great',
    label: 'Great',
    multiplier: 1.5
  },
  {
    key: 'ultra',
    label: 'Ultra',
    multiplier: 2
  }
]);

const CAPTURE_SCENARIOS = Object.freeze([
  {
    label: 'HP cheio',
    hpMultiplier: 1 / 3,
    statusMultiplier: 1
  },
  {
    label: '1 de HP',
    hpMultiplier: 1,
    statusMultiplier: 1
  },
  {
    label: '1 de HP + status',
    hpMultiplier: 1,
    statusMultiplier: 1.5
  }
]);


function captureNameCandidates(name) {
  const original =
    normalizeKey(name || '');

  if (!original) return [];

  const output = new Set([original]);

  const suffixes = [
    'alola',
    'alolan',
    'galar',
    'galarian',
    'hisui',
    'hisuian',
    'paldea',
    'paldean',
    'male',
    'female',
    'normal',
    'base',
    'form',
    'forme'
  ];

  for (const suffix of suffixes) {
    if (original.endsWith(suffix)) {
      output.add(
        original.slice(
          0,
          -suffix.length
        )
      );
    }
  }

  return [...output]
    .filter(Boolean);
}

function captureSpeciesId(
  meta,
  object
) {
  const direct =
    extractNpcSpeciesId(object);

  if (
    direct !== null &&
    CaptureData.byId[String(direct)]
  ) {
    return direct;
  }

  for (const candidate of
    captureNameCandidates(meta?.name)) {
    const nameEntry =
      PokemonData.byName[candidate];

    if (
      nameEntry &&
      CaptureData.byId[
        String(nameEntry[0])
      ]
    ) {
      return Number(nameEntry[0]);
    }
  }

  return null;
}

function extractServerCaptureRate(object) {
  return numberInRange(
    getByAliases(object, [
      'catchRate',
      'catch_rate',
      'captureRate',
      'capture_rate',
      'catchValue',
      'catch_value'
    ]),
    1,
    255
  );
}

function extractServerBaseHp(object) {
  const direct = numberInRange(
    getByAliases(object, [
      'baseHp',
      'base_hp',
      'hpBase',
      'hp_base'
    ]),
    1,
    999
  );

  if (direct !== null) {
    return direct;
  }

  const baseStats = getByAliases(object, [
    'baseStats',
    'base_stats'
  ]);

  if (
    baseStats &&
    typeof baseStats === 'object'
  ) {
    return numberInRange(
      getByAliases(baseStats, [
        'hp',
        'ps',
        'health'
      ]),
      1,
      999
    );
  }

  return null;
}

function captureSpeciesRecord(snapshot) {
  const object =
    snapshot?.candidate?.object;

  const meta =
    snapshot?.meta || {};

  const speciesId =
    captureSpeciesId(
      meta,
      object
    );

  const local =
    speciesId !== null
      ? CaptureData.byId[
          String(speciesId)
        ]
      : null;

  const baseHp =
    extractServerBaseHp(object) ??
    (
      Array.isArray(local)
        ? Number(local[0])
        : null
    );

  const catchRate =
    extractServerCaptureRate(object) ??
    (
      Array.isArray(local)
        ? Number(local[1])
        : null
    );

  if (
    !Number.isFinite(baseHp) ||
    !Number.isFinite(catchRate)
  ) {
    return null;
  }

  return {
    speciesId,
    baseHp,
    catchRate
  };
}

function fixedCaptureChance(
  catchRate,
  ballMultiplier,
  hpMultiplier,
  statusMultiplier
) {
  return Math.min(
    100,
    Math.max(
      0,
      (
        catchRate /
        255
      ) *
      ballMultiplier *
      hpMultiplier *
      statusMultiplier *
      100
    )
  );
}

function formatCaptureChance(value) {
  if (settings.captureRoundUp) {
    return `${Math.ceil(value)}%`;
  }

  return `${value.toLocaleString(
    'pt-BR',
    {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }
  )}%`;
}

function captureChanceCellClass(value) {
  if (value >= 100) {
    return 'ih-capture-perfect';
  }

  if (value >= 75) {
    return 'ih-capture-high';
  }

  return '';
}

function captureChanceCardHtml() {
  if (
    !activeEncounter?.captureEligible
  ) {
    return '';
  }

  const record =
    captureSpeciesRecord(
      activeEncounter.snapshot
    );

  if (!record) {
    return `
      <section
        id="ih-capture-forecast"
        class="ih-card ih-capture-card"
      >
        <h3>
          CHANCE DE CAPTURA
          <small>DADOS INDISPONÍVEIS</small>
        </h3>

        <p class="ih-capture-note">
          O HP base ou o catch rate desta espécie não foi identificado.
        </p>
      </section>
    `;
  }

  const rows = CAPTURE_SCENARIOS
    .map(scenario => {
      const cells = CAPTURE_BALLS
        .map(ball => {
          const chance =
            fixedCaptureChance(
              record.catchRate,
              ball.multiplier,
              scenario.hpMultiplier,
              scenario.statusMultiplier
            );

          return `
            <td class="${captureChanceCellClass(chance)}">
              ${escapeHtml(
                formatCaptureChance(chance)
              )}
            </td>
          `;
        })
        .join('');

      return `
        <tr>
          <th>${escapeHtml(scenario.label)}</th>
          ${cells}
        </tr>
      `;
    })
    .join('');

  return `
    <section
      id="ih-capture-forecast"
      class="ih-card ih-capture-card"
    >
      <h3>
        CHANCE DE CAPTURA

        <button
          type="button"
          class="ih-capture-round"
          data-capture-round
          aria-pressed="${settings.captureRoundUp ? 'true' : 'false'}"
          aria-label="Alternar arredondamento da chance de captura"
          title="Alternar arredondamento"
        >
          <span
            class="ih-round-pokeball"
            aria-hidden="true"
          ></span>

          <span class="ih-visually-hidden">
            Arredondar resultados
          </span>
        </button>
      </h3>

      <div class="ih-capture-meta">
        <span>HP base ${escapeHtml(record.baseHp)}</span>
        <span>Catch rate ${escapeHtml(record.catchRate)}</span>
      </div>

      <div class="ih-capture-table-wrap">
        <table class="ih-capture-table">
          <thead>
            <tr>
              <th>CENÁRIO</th>

              ${CAPTURE_BALLS
                .map(ball => `
                  <th>
                    <i class="ih-ball ih-ball-${ball.key}"></i>
                    <span>${escapeHtml(ball.label)}</span>
                  </th>
                `)
                .join('')}
            </tr>
          </thead>

          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>

      <p class="ih-capture-note">
        Estimativa fixa da espécie. O status usa multiplicador ×1,5.
      </p>
    </section>
  `;
}

function refreshCaptureForecast() {
  if (!body) return;

  body.querySelector(
    '#ih-capture-forecast'
  )?.remove();

  if (
    !activeEncounter?.snapshot ||
    !activeEncounter.captureEligible
  ) {
    return;
  }

  const source =
    body.querySelector('.ih-source');

  const html =
    captureChanceCardHtml();

  if (!html) return;

  if (source) {
    source.insertAdjacentHTML(
      'beforebegin',
      html
    );
  } else {
    body.insertAdjacentHTML(
      'beforeend',
      html
    );
  }

  prepareCollapsibleSections();
  enforceFixedPanelBlockOrder();
}

function isStoredPokemonCandidate(candidate, detail) {
  if (!candidate) return false;

  const path = String(candidate.path || '');
  const url = String(detail?.meta?.url || '');

  return (
    /(?:^|[.$\[])(?:pc|pcjson|storage|stored|box|boxes|collection|owned|inventory|pokedex)(?:[.\[\]_/:-]|$)/i
      .test(`${path} ${url}`)
  );
}

function createEncounterSnapshot(
  candidate,
  detail,
  mode,
  trainerName = null
) {
  const object = candidate.object;
  const ivs = extractIvSet(object) || {};
  const stats = extractStats(object);

  // The game sometimes sends a sparse wild opponent without its type.
  // Use the local species database for every battle mode, not only NPC.
  const meta = withNpcTypeFallback(
    extractMeta(object),
    object
  );

  return {
    candidate,
    detail,
    mode,
    trainerName,
    ivs,
    stats,
    meta
  };
}


function npcSnapshotQuality(snapshot) {
  if (!snapshot) return 0;

  const ivCount =
    Object.keys(snapshot.ivs || {}).length;

  const statCount =
    Object.keys(snapshot.stats || {}).length;

  const meta = snapshot.meta || {};

  let score = 0;

  score += ivCount * 20;
  score += statCount * 6;

  if (meta.nature) score += 16;
  if (meta.ability) score += 16;
  if (meta.heldItemObserved) score += 4;
  if (Array.isArray(meta.types) && meta.types.length) {
    score += meta.types.length * 7;
  }

  if (meta.bst) score += 4;
  return score;
}

function npcSnapshotKey(meta, withLevel = true) {
  const name = normalizeKey(meta?.name || '');

  if (!name) return null;

  if (!withLevel) {
    return `${name}|*`;
  }

  const level =
    Number.isFinite(meta?.level)
      ? meta.level
      : '*';

  return `${name}|${level}`;
}

function isNpcRosterPath(path, object, detail) {
  const pathText = String(path || '');

  if (
    /(?:^|[.\[])(?:player|self|mine|my|ally|owned|collection|pcjson|storage|box|inventory|pokedex)(?:[.\[\]_/:-]|$)/i
      .test(pathText)
  ) {
    return false;
  }

  if (
    /(?:^|[.\[])(?:foe|opponent|enemy|rival|trainer|npc|leader|boss)(?:[.\[\]_/:-]|$)/i
      .test(pathText)
  ) {
    return true;
  }

  if (
    hasNpcOpponentFlag(object) ||
    hasNpcTrainerFlag(object)
  ) {
    return true;
  }

  const context = objectContextText(
    object,
    pathText,
    detail
  );

  return (
    NPC_OPPONENT_CONTEXT.test(context) &&
    NPC_SIGNAL.test(context)
  );
}

function mergeCachedNpcRecord(existing, incoming) {
  if (!existing) return incoming;

  if (!sameEncounterPokemon(existing, incoming)) {
    return (
      npcSnapshotQuality(incoming) >
      npcSnapshotQuality(existing)
        ? incoming
        : existing
    );
  }

  return mergeEncounterSnapshots(
    existing,
    incoming
  );
}

function storeNpcBattleSnapshot(snapshot) {
  const exactKey =
    npcSnapshotKey(snapshot.meta, true);

  const nameKey =
    npcSnapshotKey(snapshot.meta, false);

  if (!exactKey || !nameKey) return;

  for (const key of [exactKey, nameKey]) {
    const existing =
      npcBattleRecordCache.get(key) || null;

    npcBattleRecordCache.set(
      key,
      mergeCachedNpcRecord(
        existing,
        snapshot
      )
    );
  }
}

function cacheNpcBattleRecords(root, detail) {
  if (!root || typeof root !== 'object') {
    return;
  }

  const queue = [{
    value: root,
    path: '$'
  }];

  const seen = new WeakSet();
  let inspected = 0;

  while (queue.length && inspected < 9000) {
    const current = queue.shift();
    inspected++;

    if (
      !current.value ||
      typeof current.value !== 'object' ||
      seen.has(current.value)
    ) {
      continue;
    }

    seen.add(current.value);

    if (
      !Array.isArray(current.value) &&
      isNpcRosterPath(
        current.path,
        current.value,
        detail
      )
    ) {
      const snapshot = createEncounterSnapshot(
        {
          object: current.value,
          path: current.path,
          score: 0
        },
        detail,
        'npc',
        findNpcTrainerName(root)
      );

      const meta = snapshot.meta || {};
      const ivCount =
        Object.keys(snapshot.ivs || {}).length;

      const statCount =
        Object.keys(snapshot.stats || {}).length;

      const hasUsefulDetails =
        ivCount >= 4 ||
        statCount >= 4 ||
        Boolean(meta.nature) ||
        Boolean(meta.ability);

      if (
        meta.name &&
        hasUsefulDetails
      ) {
        storeNpcBattleSnapshot(snapshot);
      }
    }

    if (Array.isArray(current.value)) {
      current.value
        .slice(0, 600)
        .forEach((item, index) => {
          if (item && typeof item === 'object') {
            queue.push({
              value: item,
              path: `${current.path}[${index}]`
            });
          }
        });
    } else {
      Object.entries(current.value)
        .slice(0, 700)
        .forEach(([key, item]) => {
          if (item && typeof item === 'object') {
            queue.push({
              value: item,
              path: `${current.path}.${key}`
            });
          }
        });
    }
  }
}

function findCachedNpcSnapshot(meta) {
  const exactKey =
    npcSnapshotKey(meta, true);

  const nameKey =
    npcSnapshotKey(meta, false);

  return (
    (exactKey
      ? npcBattleRecordCache.get(exactKey)
      : null) ||
    (nameKey
      ? npcBattleRecordCache.get(nameKey)
      : null) ||
    null
  );
}

function enrichNpcSnapshotFromCache(snapshot) {
  const cached =
    findCachedNpcSnapshot(snapshot.meta);

  if (!cached) return snapshot;

  return mergeEncounterSnapshots(
    cached,
    snapshot
  );
}

function sameEncounterPokemon(previous, next) {
  if (!previous || !next) return false;

  const previousName =
    normalizeKey(previous.meta?.name || '');

  const nextName =
    normalizeKey(next.meta?.name || '');

  if (
    !previousName ||
    !nextName ||
    previousName !== nextName
  ) {
    return false;
  }

  const previousLevel = previous.meta?.level;
  const nextLevel = next.meta?.level;

  if (
    Number.isFinite(previousLevel) &&
    Number.isFinite(nextLevel) &&
    previousLevel !== nextLevel
  ) {
    return false;
  }

  return true;
}

function mergeEncounterSnapshots(previous, next) {
  if (!sameEncounterPokemon(previous, next)) {
    return next;
  }

  const previousMeta = previous.meta || {};
  const nextMeta = next.meta || {};

  return {
    ...next,
    mode: next.mode || previous.mode,
    trainerName:
      next.trainerName ||
      previous.trainerName ||
      null,
    ivs: {
      ...(previous.ivs || {}),
      ...(next.ivs || {})
    },
    stats: {
      ...(previous.stats || {}),
      ...(next.stats || {})
    },
    meta: {
      name:
        nextMeta.name ??
        previousMeta.name ??
        null,
      level:
        nextMeta.level ??
        previousMeta.level ??
        null,
      nature:
        nextMeta.nature ??
        previousMeta.nature ??
        null,
      ability:
        nextMeta.ability ??
        previousMeta.ability ??
        null,
      heldItem:
        nextMeta.heldItemObserved === true
          ? nextMeta.heldItem
          : (
              previousMeta.heldItem ??
              null
            ),
      heldItemObserved:
        nextMeta.heldItemObserved === true ||
        previousMeta.heldItemObserved === true,
      bst:
        nextMeta.bst ??
        previousMeta.bst ??
        null,
      shiny:
        nextMeta.shiny ??
        previousMeta.shiny ??
        null,
      types:
        Array.isArray(nextMeta.types) &&
        nextMeta.types.length
          ? nextMeta.types
          : (
              Array.isArray(previousMeta.types)
                ? previousMeta.types
                : []
            )
    }
  };
}

function prepareEncounterSnapshot(
  candidate,
  detail,
  mode,
  trainerName = null
) {
  let next = createEncounterSnapshot(
    candidate,
    detail,
    mode,
    trainerName
  );

  if (mode === 'npc') {
    next = enrichNpcSnapshotFromCache(next);
  }

  const previous =
    activeEncounter?.snapshot || null;

  return mergeEncounterSnapshots(
    previous,
    next
  );
}

function candidateMatchesActivePokemon(
  candidate,
  detail,
  mode = null
) {
  if (!activeEncounter?.snapshot || !candidate) {
    return false;
  }

  const next = createEncounterSnapshot(
    candidate,
    detail,
    mode || activeEncounter.mode || 'wild',
    activeEncounter.snapshot.trainerName || null
  );

  return sameEncounterPokemon(
    activeEncounter.snapshot,
    next
  );
}


const COLLAPSIBLE_SECTION_CONFIG = {
  ivs: {
    title: 'STATUS & IVS EXATOS',
    setting: 'ivsCollapsed'
  },
  effects: {
    title: 'FRAQUEZAS & RESISTÊNCIAS',
    setting: 'effectsCollapsed'
  },
  recommendation: {
    title: 'RECOMENDAÇÃO',
    setting: 'recommendationCollapsed'
  },
  ko: {
    title: 'CHANCE DE MATAR',
    titles: [
      'CHANCE DE MATAR',
      'CHANCE DE TIRAR BARRA'
    ],
    setting: 'koCollapsed'
  },
  capture: {
    title: 'CHANCE DE CAPTURA',
    setting: 'captureCollapsed'
  }
};

function collapsibleSectionKey(card) {
  const heading = card?.querySelector(':scope > h3');

  if (!heading) return null;

  const title = heading.childNodes.length
    ? [...heading.childNodes]
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase()
    : heading.textContent
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();

  for (const [key, config] of Object.entries(
    COLLAPSIBLE_SECTION_CONFIG
  )) {
    const titles =
      config.titles ||
      [config.title];

    if (
      titles.some(candidate =>
        title.includes(candidate)
      )
    ) {
      return key;
    }
  }

  return null;
}

function applyCollapsibleSectionState(
  card,
  sectionKey
) {
  const config =
    COLLAPSIBLE_SECTION_CONFIG[sectionKey];

  if (!config) return;

  const collapsed =
    Boolean(settings[config.setting]);

  const button = card.querySelector(
    ':scope > .ih-section-header ' +
    '[data-section-toggle]'
  );

  card.classList.toggle(
    'ih-section-collapsed',
    collapsed
  );

  if (button) {
    button.textContent = collapsed ? '+' : '−';
    button.setAttribute(
      'aria-expanded',
      String(!collapsed)
    );
    button.setAttribute(
      'title',
      collapsed
        ? `Expandir ${config.title.toLowerCase()}`
        : `Minimizar ${config.title.toLowerCase()}`
    );
    button.setAttribute(
      'aria-label',
      collapsed
        ? `Expandir ${config.title.toLowerCase()}`
        : `Minimizar ${config.title.toLowerCase()}`
    );
  }
}

function applyCollapsibleSections() {
  if (!body) return;

  for (const card of body.querySelectorAll(
    '.ih-card[data-collapsible-section]'
  )) {
    applyCollapsibleSectionState(
      card,
      card.dataset.collapsibleSection
    );
  }
}

function prepareCollapsibleSections() {
  if (!body) return;

  const cards = body.querySelectorAll(
    '.ih-card:not([data-collapsible-section])'
  );

  for (const card of cards) {
    const sectionKey =
      collapsibleSectionKey(card);

    if (!sectionKey) continue;

    const heading =
      card.querySelector(':scope > h3');

    if (!heading) continue;

    const header =
      document.createElement('div');

    header.className = 'ih-section-header';

    const content =
      document.createElement('div');

    content.className = 'ih-section-content';

    const button =
      document.createElement('button');

    button.type = 'button';
    button.className = 'ih-section-toggle';
    button.dataset.sectionToggle = sectionKey;

    const contentId =
      `ih-section-${sectionKey}-content`;

    content.id = contentId;
    button.setAttribute(
      'aria-controls',
      contentId
    );

    card.dataset.collapsibleSection =
      sectionKey;

    card.insertBefore(header, heading);
    header.appendChild(heading);
    header.appendChild(button);

    while (header.nextSibling) {
      content.appendChild(
        header.nextSibling
      );
    }

    card.appendChild(content);

    applyCollapsibleSectionState(
      card,
      sectionKey
    );
  }
}

function toggleCollapsibleSection(
  sectionKey
) {
  const config =
    COLLAPSIBLE_SECTION_CONFIG[sectionKey];

  if (!config) return;

  settings[config.setting] =
    !Boolean(settings[config.setting]);

  applyCollapsibleSections();
  saveSettings();
}




function eventBrasiliaParts(
  date = new Date()
) {
  const formatter =
    new Intl.DateTimeFormat(
      'en-CA',
      {
        timeZone: EVENT_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      }
    );

  const values = {};

  for (
    const part of formatter.formatToParts(date)
  ) {
    if (part.type !== 'literal') {
      values[part.type] = Number(part.value);
    }
  }

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second
  };
}


function eventPartsToPseudoMs(parts) {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
}


function eventSlotKeyFromPseudoMs(
  pseudoMs
) {
  const date = new Date(pseudoMs);

  const year = String(
    date.getUTCFullYear()
  ).padStart(4, '0');

  const month = String(
    date.getUTCMonth() + 1
  ).padStart(2, '0');

  const day = String(
    date.getUTCDate()
  ).padStart(2, '0');

  const hour = String(
    date.getUTCHours()
  ).padStart(2, '0');

  return `${year}-${month}-${day}T${hour}:00`;
}


function eventSlotPseudoMs(slotKey) {
  const match = String(slotKey || '').match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):00$/
  );

  if (!match) {
    return eventSlotPseudoMs(
      EVENT_INITIAL_CONFIRMED_SLOT
    );
  }

  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    0,
    0
  );
}


function latestOddEventSlot(
  date = new Date()
) {
  const parts = eventBrasiliaParts(date);

  const slot = new Date(
    eventPartsToPseudoMs({
      ...parts,
      minute: 0,
      second: 0
    })
  );

  if (slot.getUTCHours() % 2 === 0) {
    slot.setUTCHours(
      slot.getUTCHours() - 1
    );
  }

  return {
    key: eventSlotKeyFromPseudoMs(
      slot.getTime()
    ),
    pseudoMs: slot.getTime()
  };
}


function eventCountdownModel(
  date = new Date()
) {
  const parts = eventBrasiliaParts(date);
  const nowPseudoMs =
    eventPartsToPseudoMs(parts);

  const lastConfirmedKey =
    settings.eventLastConfirmedSlot ||
    EVENT_INITIAL_CONFIRMED_SLOT;

  const lastConfirmedMs =
    eventSlotPseudoMs(lastConfirmedKey);

  const currentHourSlotMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    0,
    0
  );

  const isActiveOddWindow =
    parts.hour % 2 === 1 &&
    parts.minute === 0 &&
    (
      parts.second * 1000
    ) < EVENT_WINDOW_ACTIVE_MS &&
    currentHourSlotMs > lastConfirmedMs;

  let targetMs;

  if (isActiveOddWindow) {
    targetMs = currentHourSlotMs;
  } else {
    const nextHour =
      parts.hour % 2 === 0
        ? parts.hour + 1
        : parts.hour + 2;

    targetMs = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      nextHour,
      0,
      0
    );
  }

  // If the current window has just been confirmed, jump directly
  // to the next two-hour window and restart at 30%.
  if (targetMs <= lastConfirmedMs) {
    targetMs = lastConfirmedMs +
      (2 * 60 * 60 * 1000);
  }

  const elapsedWindows = Math.max(
    1,
    Math.round(
      (
        targetMs -
        lastConfirmedMs
      ) /
      (2 * 60 * 60 * 1000)
    )
  );

  const chance = Math.min(
    100,
    elapsedWindows * 30
  );

  const remainingMs = Math.max(
    0,
    targetMs - nowPseudoMs
  );

  return {
    chance,
    isNow:
      isActiveOddWindow &&
      targetMs === currentHourSlotMs,
    remainingMs,
    targetKey:
      eventSlotKeyFromPseudoMs(targetMs),
    targetMs,
    lastConfirmedKey,
    lastConfirmedMs
  };
}


function formatEventCountdown(
  remainingMs
) {
  const totalSeconds = Math.max(
    0,
    Math.floor(remainingMs / 1000)
  );

  const hours = Math.floor(
    totalSeconds / 3600
  );

  const minutes = Math.floor(
    (totalSeconds % 3600) / 60
  );

  const seconds = totalSeconds % 60;

  return [
    hours,
    minutes,
    seconds
  ]
    .map(value =>
      String(value).padStart(2, '0')
    )
    .join(':');
}


function eventSlotTimeLabel(slotKey) {
  const match = String(slotKey || '').match(
    /T(\d{2}):00$/
  );

  return match
    ? `${match[1]}:00`
    : '—';
}


function buildEventCountdownCard() {
  return `
    <section
      class="ih-event-countdown"
      aria-label="Próxima janela de evento"
    >
      <div class="ih-event-heading">
        <span
          class="ih-event-star"
          aria-hidden="true"
        >★</span>

        <div>
          <strong>PRÓXIMA CHANCE DE EVENTO</strong>
          <small>Horário de Brasília</small>
        </div>
      </div>

      <div class="ih-event-main">
        <strong data-event-countdown>
          --:--:--
        </strong>
      </div>

      <div class="ih-event-meta">
        <span>
          Próxima janela:
          <strong data-event-next>--:--</strong>
        </span>

        <span>
          Último confirmado:
          <strong data-event-last>13:00</strong>
        </span>
      </div>

      <div class="ih-event-actions">
        <button
          type="button"
          class="ih-event-confirm-button"
          data-event-confirmed
          title="Reiniciar o ciclo após o Pokémon do evento aparecer"
        >
          ✨ Pokémon apareceu
        </button>
      </div>
    </section>
  `;
}


function updateEventCountdownDisplay() {
  if (!body) return;

  const card = body.querySelector(
    '.ih-event-countdown'
  );

  if (!card) return;

  const model = eventCountdownModel();

  const countdown =
    card.querySelector(
      '[data-event-countdown]'
    );

  const next =
    card.querySelector(
      '[data-event-next]'
    );

  const last =
    card.querySelector(
      '[data-event-last]'
    );

  if (countdown) {
    countdown.textContent =
      model.isNow
        ? 'AGORA'
        : formatEventCountdown(
            model.remainingMs
          );
  }

  if (next) {
    next.textContent =
      eventSlotTimeLabel(
        model.targetKey
      );
  }

  if (last) {
    last.textContent =
      eventSlotTimeLabel(
        model.lastConfirmedKey
      );
  }

  card.classList.toggle(
    'ih-event-now',
    model.isNow
  );
}




function confirmCurrentEventWindow() {
  const latest =
    latestOddEventSlot();

  settings.eventLastConfirmedSlot =
    latest.key;

  saveSettings();
  updateEventCountdownDisplay();

  const button = body?.querySelector(
    '[data-event-confirmed]'
  );

  if (button) {
    const original =
      '✨ Pokémon apareceu';

    button.textContent =
      `✓ Ciclo reiniciado às ${
        eventSlotTimeLabel(latest.key)
      }`;

    setTimeout(() => {
      if (button.isConnected) {
        button.textContent = original;
      }
    }, 1800);
  }
}


  function createPanel() {
    if (panel || !document.documentElement) return;

    panel = document.createElement('section');
    panel.id = 'infinity-help-panel';

    panel.innerHTML = `
      <header class="ih-header">
        <div class="ih-header-brand">
          <img src="${escapeHtml(LOGO_URL)}" alt="">

          <div class="ih-header-meta">
            <span class="ih-version">v0.2.8.21</span>

            <span class="ih-credit">
              <small>Desenvolvido por:</small>
              <strong>Lucca</strong>
            </span>
          </div>
        </div>

        <div class="ih-header-actions">
          <button
            type="button"
            data-action="close"
            title="Fechar"
            aria-label="Fechar InfinityHelp"
          >×</button>

          <button
            type="button"
            data-action="collapse"
            title="Minimizar"
          >−</button>
        </div>
      </header>

      <div class="ih-body"></div>

      <div
        class="ih-resize-handle"
        title="Arraste para redimensionar"
        aria-label="Redimensionar painel"
      ></div>
    `;

    document.documentElement.appendChild(panel);
    body = panel.querySelector('.ih-body');

    body.addEventListener('click', event => {
      const eventConfirmedButton =
        event.target.closest(
          '[data-event-confirmed]'
        );

      if (
        eventConfirmedButton &&
        body.contains(eventConfirmedButton)
      ) {
        event.preventDefault();
        event.stopPropagation();

        confirmCurrentEventWindow();
        return;
      }

      const roundButton = event.target.closest(
        '[data-capture-round]'
      );

      if (
        roundButton &&
        body.contains(roundButton)
      ) {
        event.preventDefault();
        event.stopPropagation();

        settings.captureRoundUp =
          !Boolean(settings.captureRoundUp);

        saveSettings();
        refreshCaptureForecast();
        return;
      }

      const button = event.target.closest(
        '[data-section-toggle]'
      );

      if (
        !button ||
        !body.contains(button)
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      toggleCollapsibleSection(
        button.dataset.sectionToggle
      );
    });

    panel
      .querySelector('[data-action="collapse"]')
      .addEventListener('click', () => {
        settings.collapsed = !settings.collapsed;
        applySettings();
        saveSettings();
      });

    panel
      .querySelector('[data-action="close"]')
      .addEventListener('click', () => {
        settings.enabled = false;
        applySettings();
        saveSettings();
      });

    makeDraggable(
      panel,
      panel.querySelector('.ih-header')
    );

    makeResizable(
      panel,
      panel.querySelector('.ih-resize-handle')
    );

    applySettings();
    renderIdle();
  }

  function makeDraggable(element, handle) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener('pointerdown', event => {
      if (event.target.closest('button')) return;

      dragging = true;
      const rect = element.getBoundingClientRect();

      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;

      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener('pointermove', event => {
      if (!dragging) return;

      const maxX = Math.max(
        0,
        window.innerWidth - element.offsetWidth
      );
      const maxY = Math.max(
        0,
        window.innerHeight - element.offsetHeight
      );

      settings.panelX = Math.max(
        0,
        Math.min(maxX, event.clientX - offsetX)
      );

      settings.panelY = Math.max(
        0,
        Math.min(maxY, event.clientY - offsetY)
      );

      element.style.left = `${settings.panelX}px`;
      element.style.top = `${settings.panelY}px`;
      element.style.right = 'auto';
      element.style.bottom = 'auto';
    });

    handle.addEventListener('pointerup', event => {
      dragging = false;

      try {
        handle.releasePointerCapture(event.pointerId);
      } catch (_) {}

      saveSettings();
    });
  }

  function makeResizable(element, handle) {
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;

    handle.addEventListener('pointerdown', event => {
      resizing = true;
      const rect = element.getBoundingClientRect();

      startX = event.clientX;
      startY = event.clientY;
      startWidth = rect.width;
      startHeight = rect.height;

      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });

    handle.addEventListener('pointermove', event => {
      if (!resizing) return;

      const maxWidth = Math.max(
        280,
        window.innerWidth - element.offsetLeft - 8
      );

      const maxHeight = Math.max(
        160,
        window.innerHeight - element.offsetTop - 8
      );

      const width = Math.max(
        280,
        Math.min(
          maxWidth,
          startWidth + event.clientX - startX
        )
      );

      const height = Math.max(
        160,
        Math.min(
          maxHeight,
          startHeight + event.clientY - startY
        )
      );

      settings.panelWidth = Math.round(width);
      settings.panelHeight = Math.round(height);

      element.style.width = `${settings.panelWidth}px`;
      element.style.height = `${settings.panelHeight}px`;
    });

    handle.addEventListener('pointerup', event => {
      resizing = false;

      try {
        handle.releasePointerCapture(event.pointerId);
      } catch (_) {}

      saveSettings();
    });
  }

  function applySettings() {
    if (!panel) return;

    panel.hidden = !settings.enabled;
    panel.classList.toggle(
      'ih-collapsed',
      settings.collapsed
    );
    panel.classList.toggle(
      'ih-show-diagnostic',
      settings.diagnostic
    );

    const maxWidth = Math.max(
      280,
      window.innerWidth - 16
    );

    const width = Math.min(
      maxWidth,
      Math.max(280, Number(settings.panelWidth) || 330)
    );

    panel.style.width = `${width}px`;

    if (
      Number.isFinite(settings.panelHeight) &&
      settings.panelHeight >= 160
    ) {
      const maxHeight = Math.max(
        160,
        window.innerHeight - 16
      );
      panel.style.height =
        `${Math.min(maxHeight, settings.panelHeight)}px`;
    } else {
      panel.style.height = 'auto';
    }

    const x = Math.max(
      0,
      Math.min(
        window.innerWidth - width,
        Number(settings.panelX) || 0
      )
    );

    const currentHeight =
      panel.getBoundingClientRect().height || 160;

    const y = Math.max(
      0,
      Math.min(
        Math.max(0, window.innerHeight - currentHeight),
        Number(settings.panelY) || 0
      )
    );

    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';

    applyCollapsibleSections();
  }

  function saveSettings() {
    chrome.storage.local.set({
      [STORAGE_KEY]: settings
    });
  }

  function renderIdle(message = 'Aguardando encontro selvagem ou batalha contra NPC…') {
    createPanel();
    activeEncounter = null;
    activePlayerPokemon = null;
    activePlayerPokemonSource = null;
    activePlayerPokemonUpdatedAt = 0;
    clearActiveBattleAuthority();
    clearActiveOpponentBattleState();
    activePlayerDomConfirmedAt = 0;
    activePlayerDomLockedKey = null;
    activePlayerSwitchEventKey = null;
    activePlayerSwitchEventSlot = null;
    activePlayerSwitchEventPokemon = null;
    activePlayerSwitchEventUpdatedAt = 0;

    if (activePlayerDomSyncTimer) {
      clearTimeout(activePlayerDomSyncTimer);
      activePlayerDomSyncTimer = null;
    }

    stopMoveRescanLoop();
    npcBattleRecordCache.clear();

    if (encounterTimer) {
      clearTimeout(encounterTimer);
      encounterTimer = null;
    }

    if (endConfirmationTimer) {
      clearTimeout(endConfirmationTimer);
      endConfirmationTimer = null;
    }

    body.innerHTML = `
      ${buildEventCountdownCard()}

      <div class="ih-idle">
        <img
          src="${escapeHtml(LOGO_URL)}"
          alt="InfinityHelp"
          class="ih-idle-logo"
        >

        <div class="ih-idle-orb">
          <span></span>
        </div>

        <strong>${escapeHtml(message)}</strong>
        <small>
          Os dados aparecem automaticamente quando um
          Pokémon selvagem ou adversário NPC é reconhecido.
        </small>
      </div>
    `;

    diagnosticPre = null;

    updateEventCountdownDisplay();
    applySettings();
  }


function clearActivePlayerAfterTerminalResult() {
  clearActiveOpponentBattleState();
  activePlayerPokemon = null;
  activePlayerPokemonSource = null;
  activePlayerPokemonUpdatedAt = 0;
  clearActiveBattleAuthority();

  activePlayerDomConfirmedAt = 0;
  activePlayerDomLockedKey = null;

  activePlayerSwitchEventKey = null;
  activePlayerSwitchEventSlot = null;
  activePlayerSwitchEventPokemon = null;
  activePlayerSwitchEventUpdatedAt = 0;

  if (activePlayerDomSyncTimer) {
    clearTimeout(activePlayerDomSyncTimer);
    activePlayerDomSyncTimer = null;
  }
}

function resetEncounterTimer() {
  if (encounterTimer) {
    clearTimeout(encounterTimer);
    encounterTimer = null;
  }

  if (endConfirmationTimer) {
    clearTimeout(endConfirmationTimer);
    endConfirmationTimer = null;
  }
}

function requestConfirmedEncounterEnd(
  detail,
  evidence
) {
  if (!activeEncounter || !evidence) return;

  if (endConfirmationTimer) {
    clearTimeout(endConfirmationTimer);
  }

  const delay =
    evidence === 'terminal'
      ? TERMINAL_RESULT_CONFIRMATION_MS
      : FOE_GONE_CONFIRMATION_MS;

  endConfirmationTimer = setTimeout(() => {
    endConfirmationTimer = null;

    if (!activeEncounter) return;

    renderIdle();
    renderDiagnostic(detail);
  }, delay);
}

  function renderDiagnostic(detail) {
    if (!diagnosticPre) return;

    let text = '';

    try {
      text = JSON.stringify(
        {
          source: detail.source,
          timestamp:
            new Date(detail.timestamp).toLocaleTimeString(),
          meta: detail.meta,
          value: detail.value
        },
        null,
        2
      );
    } catch (_) {
      text = String(detail);
    }

    diagnosticPre.textContent =
      text.slice(0, 90000);
  }

  function renderEncounter(candidate, detail) {
    createPanel();

    const snapshot = prepareEncounterSnapshot(
      candidate,
      detail,
      'wild'
    );

    const ivs = snapshot.ivs;
    const stats = snapshot.stats;
    const meta = snapshot.meta;

    const effects = buildEffectiveness(
      meta.types,
      meta.ability
    );

    const ivTotal = buildIvTotal(ivs);
    const name = meta.name || 'Pokémon selvagem';

    const shinyAlert =
      buildShinyEncounterAlert(
        meta,
        'wild'
      );

    const subtitle = [
      meta.level ? `Nível ${meta.level}` : null,
      meta.bst ? `${meta.bst} BST` : null,
      meta.types.length
        ? meta.types
            .map(type => TYPE_LABELS[type])
            .join(' / ')
        : null
    ]
      .filter(Boolean)
      .join(' · ');

    const ivCards = buildIvCards(
      ivs,
      stats,
      meta.nature
    );

    const perfectIvNotice =
      buildPerfectIvNotice(ivs);

    const typeSection = effects
      ? `
        <section class="ih-card ih-effect-card">
          <h3>
            FRAQUEZAS & RESISTÊNCIAS
            ${
              meta.ability
                ? `<small>HAB: ${escapeHtml(meta.ability)}</small>`
                : ''
            }
          </h3>

          ${effectRow('FRACO', 'ih-label-weak', effects.weak)}
          ${effectRow('RESISTE', 'ih-label-resist', effects.resist)}
          ${effectRow('IMUNE', 'ih-label-immune', effects.immune)}
          ${effectRow('FORTE', 'ih-label-strong', effects.strong)}

          <p class="ih-effect-note">
            “Forte” considera os tipos do Pokémon como
            ataques STAB, não os golpes equipados.
          </p>
        </section>
      `
      : `
        <section class="ih-card ih-effect-card">
          <h3>FRAQUEZAS & RESISTÊNCIAS</h3>
          <p class="ih-missing-types">
            Os tipos ainda não foram reconhecidos nos
            dados deste encontro.
          </p>
        </section>
      `;

    body.innerHTML = `
      ${buildEventCountdownCard()}

      <div class="ih-found">
        IVs encontrados no encontro atual.
      </div>

      ${shinyAlert}

      <div class="ih-pokemon-title">
        <strong>${escapeHtml(name)}</strong>
        <small>${escapeHtml(subtitle)}</small>
      </div>

      ${
        ivTotal
          ? `
            <div class="ih-iv-total">
              <span>IV TOTAL</span>
              <strong>
                ${ivTotal.total}/${ivTotal.maximum}
                · ${escapeHtml(
                  formatIvPercentage(ivTotal.percentage)
                )}
              </strong>
            </div>
          `
          : ''
      }

      <section class="ih-card">
        <h3>STATUS & IVS EXATOS</h3>

        ${perfectIvNotice}

        <div class="ih-iv-grid">
          ${ivCards}
        </div>

        <div class="ih-divider"></div>

        <div class="ih-meta">
          <strong>Natureza:</strong>
          ${escapeHtml(meta.nature || '—')}
          <span>·</span>
          <strong>Hab:</strong>
          ${escapeHtml(meta.ability || '—')}
        </div>
      </section>

      ${typeSection}

      <div class="ih-source">
        Detectado via ${escapeHtml(detail.source)}
        · caminho ${escapeHtml(candidate.path)}
      </div>
    `;

    prepareCollapsibleSections();
    diagnosticPre = null;
    updateEventCountdownDisplay();

    activeEncounter = {
      candidate: snapshot.candidate,
      detail: snapshot.detail,
      renderedAt: Date.now(),
      mode: snapshot.mode,
      captureEligible: true,
      snapshot
    };

    refreshTypeRecommendation();
    refreshKoForecast();
    refreshCaptureForecast();
    scheduleActivePlayerDomSync(0);
    setTimeout(
      syncActivePlayerFromBattleDom,
      90
    );
    setTimeout(
      syncActivePlayerFromBattleDom,
      260
    );
    renderDiagnostic(detail);
    applySettings();
    resetEncounterTimer();
  }


function renderNpcEncounter(
  candidate,
  detail,
  trainerName = null
) {
  createPanel();

  const snapshot = prepareEncounterSnapshot(
    candidate,
    detail,
    'npc',
    trainerName
  );

  const ivs = snapshot.ivs;
  const stats = snapshot.stats;
  const meta = snapshot.meta;
  trainerName = snapshot.trainerName;

  const effects = buildEffectiveness(
    meta.types,
    meta.ability
  );

  const ivTotal = buildIvTotal(ivs);
  const name = meta.name || 'Pokémon do NPC';

  const subtitle = [
    meta.level ? `Nível ${meta.level}` : null,
    meta.bst ? `${meta.bst} BST` : null,
    meta.types.length
      ? meta.types
          .map(type => TYPE_LABELS[type])
          .join(' / ')
      : null
  ]
    .filter(Boolean)
    .join(' · ');

  const ivCards = buildIvCards(
    ivs,
    stats,
    meta.nature
  );

  const perfectIvNotice =
    buildPerfectIvNotice(ivs);

  const typeSection = effects
    ? `
      <section class="ih-card ih-effect-card">
        <h3>
          FRAQUEZAS & RESISTÊNCIAS
          ${
            meta.ability
              ? `<small>HAB: ${escapeHtml(meta.ability)}</small>`
              : ''
          }
        </h3>

        ${effectRow('FRACO', 'ih-label-weak', effects.weak)}
        ${effectRow('RESISTE', 'ih-label-resist', effects.resist)}
        ${effectRow('IMUNE', 'ih-label-immune', effects.immune)}
        ${effectRow('FORTE', 'ih-label-strong', effects.strong)}

        <p class="ih-effect-note">
          “Forte” considera os tipos do Pokémon como
          ataques STAB, não os golpes equipados.
        </p>
      </section>
    `
    : `
      <section class="ih-card ih-effect-card">
        <h3>FRAQUEZAS & RESISTÊNCIAS</h3>
        <p class="ih-missing-types">
          Os tipos ainda não foram reconhecidos nos
          dados desta batalha.
        </p>
      </section>
    `;

  body.innerHTML = `
    ${buildEventCountdownCard()}

    <div class="ih-npc-banner">
      <strong>BATALHA CONTRA NPC</strong>
      ${
        trainerName
          ? `<small>${escapeHtml(trainerName)}</small>`
          : ''
      }
    </div>

    <div class="ih-found">
      Dados do Pokémon adversário encontrados.
    </div>

    <div class="ih-pokemon-title">
      <strong>${escapeHtml(name)}</strong>
      <small>${escapeHtml(subtitle)}</small>
    </div>

    ${
      ivTotal
        ? `
          <div class="ih-iv-total">
            <span>IV TOTAL</span>
            <strong>
              ${ivTotal.total}/${ivTotal.maximum}
              · ${escapeHtml(
                formatIvPercentage(ivTotal.percentage)
              )}
            </strong>
          </div>
        `
        : ''
    }

    <section class="ih-card">
      <h3>STATUS & IVS EXATOS</h3>

      ${perfectIvNotice}

      <div class="ih-iv-grid">
        ${ivCards}
      </div>

      <div class="ih-divider"></div>

      <div class="ih-meta">
        <strong>Natureza:</strong>
        ${escapeHtml(meta.nature || '—')}
        <span>·</span>
        <strong>Hab:</strong>
        ${escapeHtml(meta.ability || '—')}
      </div>
    </section>

    ${typeSection}

    <div class="ih-source">
      NPC detectado via ${escapeHtml(detail.source)}
      · caminho ${escapeHtml(candidate.path)}
    </div>
  `;

  prepareCollapsibleSections();
  diagnosticPre = null;
  updateEventCountdownDisplay();

  activeEncounter = {
    candidate: snapshot.candidate,
    detail: snapshot.detail,
    renderedAt: Date.now(),
    mode: snapshot.mode,
    captureEligible: false,
    snapshot
  };

  refreshTypeRecommendation();
  refreshKoForecast();
  refreshCaptureForecast();
  scheduleActivePlayerDomSync(0);
    setTimeout(
      syncActivePlayerFromBattleDom,
      90
    );
    setTimeout(
      syncActivePlayerFromBattleDom,
      260
    );
  renderDiagnostic(detail);
  applySettings();
  resetEncounterTimer();
}

window.addEventListener(EVENT_NAME, event => {
  const detail = event.detail;

  if (!detail || !settings.enabled) return;

  createPanel();

  const isNewBattleBoundary =
    /\/api\/battle\/v2\/start(?:[?#]|$)/i
      .test(
        String(
          detail?.meta?.url || ''
        )
      );

  if (isNewBattleBoundary) {
    clearActiveBattlePartyAvailability();
    body?.querySelector(
      '#ih-type-recommendation'
    )?.remove();
  }

  const endEvidence =
    detail.source === 'localStorage' ||
    detail.source === 'sessionStorage'
      ? null
      : battleEndEvidence(detail.value);

  if (endEvidence === 'terminal') {
    // Keep newly returned party/move data (for example after capture),
    // but do not scan terminal rewards as a current battler.
    capturePlayerMovesFromPayload(
      detail.value,
      detail
    );

    updatePlayerTeam(
      detail.value,
      detail
    );

    clearActivePlayerAfterTerminalResult();
    clearActiveBattlePartyAvailability();

    if (activeEncounter) {
      requestConfirmedEncounterEnd(
        detail,
        endEvidence
      );
    }

    renderDiagnostic(detail);
    return;
  }

  const ownedPokemonDetailsChanged =
    cacheOwnedPokemonDetails(
      detail.value,
      detail
    );

  const directMovesChanged =
    capturePlayerMovesFromPayload(
      detail.value,
      detail
    );

  const teamChanged =
    updatePlayerTeam(
      detail.value,
      detail
    );

  const partyAvailabilityChanged =
    syncPlayerPartyAvailabilityFromBattleState(
      detail.value,
      detail
    );

  const ownedPokemonHydrationChanged =
    ownedPokemonDetailsChanged
      ? refreshOwnedPokemonDetailHydration()
      : false;

  const switchEventChanged =
    updateActivePlayerFromSwitchEvents(
      detail.value,
      detail
    );

  const activePlayerChanged =
    updateActivePlayerPokemon(
      detail.value,
      detail
    );

  // Final authority for every non-terminal InfinityMMO battle packet.
  // Generic party/PC scanners may enrich stats, never replace identity.
  const authoritativeBattleChanged =
    updateActivePlayerFromInfinityBattleState(
      detail.value,
      detail
    );

  const authoritativeOpponentChanged =
    updateActiveOpponentFromInfinityBattleState(
      detail.value,
      detail
    );

  if (
    (
      ownedPokemonDetailsChanged ||
      directMovesChanged ||
      teamChanged ||
      partyAvailabilityChanged ||
      ownedPokemonHydrationChanged ||
      authoritativeBattleChanged ||
      authoritativeOpponentChanged ||
      switchEventChanged ||
      activePlayerChanged
    ) &&
    activeEncounter
  ) {
    refreshTypeRecommendation();
    refreshKoForecast();
    scheduleActivePlayerDomSync(10);

    if (knownTeamMoveCount() > 0) {
      stopMoveRescanLoop();
    }
  }

  const strongNpc =
    strongNpcBattleEvidence(
      detail.value,
      detail
    );

  if (
    (
      activeEncounter?.mode === 'npc' &&
      !visibleWildBattleEvidence()
    ) ||
    strongNpc
  ) {
    cacheNpcBattleRecords(
      detail.value,
      detail
    );
  }

  // The next NPC foe can arrive only through state.foe.mon on
  // /optional-switch. Render that authoritative identity immediately and
  // enrich it from the full foeParty cached at battle start.
  if (
    syncActiveNpcOpponentFromInfinityBattleState(
      detail.value,
      detail
    )
  ) {
    return;
  }

  const candidate = findBestCandidate(
    detail.value,
    detail
  );

  if (
    candidate &&
    !isStoredPokemonCandidate(
      candidate,
      detail
    )
  ) {
    const resolvedMode =
      determineEncounterMode(
        candidate,
        detail,
        detail.value
      );

    const sameOpponent =
      candidateMatchesActivePokemon(
        candidate,
        detail,
        resolvedMode
      );

    if (resolvedMode === 'npc') {
      renderNpcEncounter(
        candidate,
        detail,
        findNpcTrainerName(detail.value) ||
        (
          sameOpponent
            ? activeEncounter
                ?.snapshot
                ?.trainerName
            : null
        )
      );
    } else {
      renderEncounter(
        candidate,
        detail
      );
    }

    if (endEvidence === 'terminal') {
      requestConfirmedEncounterEnd(
        detail,
        endEvidence
      );
    }

    return;
  }

  const npcCandidate =
    strongNpc
      ? findBestNpcCandidate(
          detail.value,
          detail
        )
      : null;

  if (
    npcCandidate &&
    !isStoredPokemonCandidate(
      npcCandidate,
      detail
    )
  ) {
    renderNpcEncounter(
      npcCandidate,
      detail,
      findNpcTrainerName(detail.value) ||
      (
        candidateMatchesActivePokemon(
          npcCandidate,
          detail,
          'npc'
        )
          ? activeEncounter
              ?.snapshot
              ?.trainerName
          : null
      )
    );

    if (endEvidence === 'terminal') {
      requestConfirmedEncounterEnd(
        detail,
        endEvidence
      );
    }

    return;
  }

  if (
    activeEncounter?.mode === 'npc' &&
    !visibleWildBattleEvidence()
  ) {
    const cachedActive =
      findCachedNpcSnapshot(
        activeEncounter.snapshot?.meta
      );

    if (
      cachedActive &&
      npcSnapshotQuality(cachedActive) >
      npcSnapshotQuality(
        activeEncounter.snapshot
      )
    ) {
      renderNpcEncounter(
        cachedActive.candidate,
        cachedActive.detail,
        cachedActive.trainerName ||
        activeEncounter
          .snapshot
          ?.trainerName ||
        null
      );

      return;
    }
  }

  if (
    activeEncounter &&
    endEvidence
  ) {
    requestConfirmedEncounterEnd(
      detail,
      endEvidence
    );

    return;
  }

  if (
    activeEncounter &&
    POSITIVE_CONTEXT.test(
      objectContextText(
        detail.value,
        '$',
        detail
      )
    )
  ) {
    resetEncounterTimer();
  }

  syncEncounterModeFromBattleDom();
  scheduleActivePlayerDomSync(10);
  renderDiagnostic(detail);
});

chrome.storage.local.get(
    {
      [STORAGE_KEY]: defaults,
      [MOVE_CACHE_STORAGE_KEY]: {}
    },
    result => {
      settings = {
        ...defaults,
        ...(result[STORAGE_KEY] || {})
      };

      playerMoveCache = sanitizeMoveCache(
        result[MOVE_CACHE_STORAGE_KEY]
      );

      const hydrated =
        hydratePlayerTeamFromMoveCache();

      readStorageDirectlyForMoves();
      dispatchMoveRescanRequest(
        'extension-startup'
      );

      createPanel();
      applySettings();

      if (
        hydrated &&
        activeEncounter
      ) {
        refreshTypeRecommendation();
        refreshKoForecast();
      }

      if (!activeEncounter) {
        renderIdle();
      }
    }
  );

  chrome.storage.onChanged.addListener(
    (changes, area) => {
      if (area !== 'local') {
        return;
      }

      if (changes[MOVE_CACHE_STORAGE_KEY]) {
        playerMoveCache = sanitizeMoveCache(
          changes[MOVE_CACHE_STORAGE_KEY]
            .newValue
        );

        if (
          hydratePlayerTeamFromMoveCache() &&
          activeEncounter
        ) {
          refreshTypeRecommendation();
          refreshKoForecast();
        }
      }

      if (!changes[STORAGE_KEY]) {
        return;
      }

      settings = {
        ...defaults,
        ...(changes[STORAGE_KEY].newValue || {})
      };

      createPanel();
      applySettings();
    }
  );

  window.addEventListener('resize', applySettings);

  startActivePlayerDomObserver();

  setInterval(() => {
    if (activeEncounter) {
      syncEncounterModeFromBattleDom();
      syncActivePlayerFromBattleDom();
    }
  }, 300);

  setInterval(
    updateEventCountdownDisplay,
    1000
  );

  chrome.runtime.sendMessage({
    action:
      'infinityHelpScheduleEventAlarms'
  }).catch(() => {});

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      createPanel,
      { once: true }
    );
  } else {
    createPanel();
  }
})();
