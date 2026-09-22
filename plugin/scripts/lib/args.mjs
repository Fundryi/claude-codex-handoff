export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

// For `task` only: lift the leading flags and keep the rest of the string as the
// prompt, byte for byte. Flag values honour quotes but not backslash escapes, so
// Windows paths survive. Anything after the first non-flag token is prompt text,
// even if it looks like a flag.
export function splitLeadingFlags(raw, { valueOptions = [], aliasMap = {} } = {}) {
  const text = String(raw ?? "");
  const tokens = [];
  let pos = 0;
  const readToken = () => {
    while (pos < text.length && /\s/.test(text[pos])) pos += 1;
    let token = "";
    let quote = null;
    while (pos < text.length) {
      const ch = text[pos];
      if (quote) {
        if (ch === quote) quote = null;
        else token += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (/\s/.test(ch)) {
        break;
      } else {
        token += ch;
      }
      pos += 1;
    }
    return token;
  };

  while (pos < text.length) {
    const start = pos;
    const token = readToken();
    if (!/^--?[a-z]/i.test(token)) {
      pos = start;
      break;
    }
    tokens.push(token);
    const name = token.replace(/^--?/, "");
    if (!name.includes("=") && valueOptions.includes(aliasMap[name] ?? name)) {
      tokens.push(readToken());
    }
  }

  const prompt = text.slice(pos).replace(/^\s+/, "");
  if (prompt) tokens.push(prompt);
  return tokens;
}
