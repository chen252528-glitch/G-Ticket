// Registers the slash commands with Discord.
//
// Usage:
//   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... node scripts/register-commands.mjs
//   Optionally set DISCORD_GUILD_ID to register guild commands (instant),
//   otherwise commands are registered globally (may take up to an hour).

const OPTION_TYPE_SUB_COMMAND = 1;
const OPTION_TYPE_STRING = 3;

const cabinChoices = [
  { name: "economy", value: "economy" },
  { name: "premium_economy", value: "premium_economy" },
  { name: "business", value: "business" },
  { name: "first", value: "first" }
];

const originOption = {
  type: OPTION_TYPE_STRING,
  name: "origin",
  description: "Origin airport/metro code, e.g. HND",
  required: true,
  min_length: 3,
  max_length: 3
};

const destinationOption = {
  type: OPTION_TYPE_STRING,
  name: "destination",
  description: "Destination airport code, e.g. TPE",
  required: true,
  min_length: 3,
  max_length: 3
};

const cabinOption = {
  type: OPTION_TYPE_STRING,
  name: "cabin",
  description: "Cabin class (default: economy)",
  required: false,
  choices: cabinChoices
};

// The scanner can only search routes with concrete travel dates (Google
// Flights requires them), so the departure date is mandatory here.
const departOption = {
  type: OPTION_TYPE_STRING,
  name: "depart",
  description: "Departure date, YYYY-MM-DD (e.g. 2026-12-26)",
  required: true,
  min_length: 10,
  max_length: 10
};

const returnOption = {
  type: OPTION_TYPE_STRING,
  name: "return",
  description: "Return date, YYYY-MM-DD (required for round_trip)",
  required: false,
  min_length: 10,
  max_length: 10
};

const tripOption = {
  type: OPTION_TYPE_STRING,
  name: "trip",
  description: "Trip type (default: round_trip)",
  required: false,
  choices: [
    { name: "round_trip", value: "round_trip" },
    { name: "one_way", value: "one_way" }
  ]
};

const commands = [
  {
    name: "track",
    description: "Manage tracked flight routes",
    options: [
      {
        type: OPTION_TYPE_SUB_COMMAND,
        name: "add",
        description: "Track a route for given travel dates (re-adding updates the dates)",
        // Discord requires every required option to come before optional ones.
        options: [originOption, destinationOption, departOption, returnOption, cabinOption, tripOption]
      },
      {
        type: OPTION_TYPE_SUB_COMMAND,
        name: "remove",
        description: "Stop tracking a route",
        options: [originOption, destinationOption, cabinOption]
      },
      {
        type: OPTION_TYPE_SUB_COMMAND,
        name: "list",
        description: "List active tracked routes"
      }
    ]
  },
  {
    name: "price",
    description: "Compare the current fare with the 60-day average (cheap or overpriced?)",
    options: [originOption, destinationOption, cabinOption]
  },
  {
    name: "scan",
    description: "Trigger a scan now via GitHub Actions",
    options: [
      {
        type: OPTION_TYPE_STRING,
        name: "job",
        description: "Which job to run",
        required: true,
        choices: [
          { name: "normal-fares", value: "normal-fares" },
          { name: "business-deals", value: "business-deals" }
        ]
      }
    ]
  },
  {
    name: "status",
    description: "Show the last job runs"
  }
];

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!applicationId || !botToken) {
  console.error("Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN environment variables first.");
  process.exit(1);
}

const url = guildId
  ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${applicationId}/commands`;

const response = await fetch(url, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${botToken}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify(commands)
});

if (!response.ok) {
  console.error(`Registration failed with status ${response.status}:`);
  console.error(await response.text());
  process.exit(1);
}

const registered = await response.json();
console.log(
  `Registered ${registered.length} command(s) ${guildId ? `in guild ${guildId} (available immediately)` : "globally (may take up to an hour to appear)"}.`
);
