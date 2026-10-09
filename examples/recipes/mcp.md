# BrowserGlass as an MCP server

`bgls mcp` speaks MCP over stdio. It opens one browser when it starts, gives the agent 41 tools (`bg_navigate`, `bg_click`, `bg_fill`, `bg_read_page`, `bg_page_map`, `bg_screenshot`, `bg_pdf`, `bg_swarm_open` and the rest), and opens more browsers when the agent asks for a swarm.

You need a gateway running first, from the repo root:

```sh
pnpm bgls serve --listen 127.0.0.1:7799
```

Below, replace `/path/to/browserglass` with the absolute path of your clone. MCP hosts start the command without a shell, so `bgls` on its own will not resolve. Point them at `node` and the built CLI.

## Credentials: use the data dir, not a pasted token

`bgls serve` writes `bgls-data/dev-session.json`. If `bgls mcp` can see that file it mints its own tokens, so set `BGLS_DATA_DIR` to the absolute path of that folder and leave the token out of the config.

You can pass `BGLS_ADMIN_TOKEN` instead, but a token from `pnpm bgls token` lasts 10 minutes by default and 15 at most. After that every tool call fails until you paste a new one.

## Claude Code

```sh
claude mcp add browserglass \
  -e BGLS_DATA_DIR=/path/to/browserglass/bgls-data \
  -- node /path/to/browserglass/packages/cli/dist/bin.mjs mcp --endpoint http://127.0.0.1:7799 --headless
```

Options go before the server name, and everything after `--` is the command. Add `-s user` to make it available in every project, or `-s project` to write it to a `.mcp.json` your team shares. Check it with:

```sh
claude mcp list
```

Inside a session, `/mcp` shows the server and its tools.

Drop `--headless` if you want to see the Chrome window. Other useful flags for `bgls mcp`: `--url <page>` to open a page at startup, `--profile-key <name>` to start on a persistent profile (logins survive), `--instance-id <id>` to attach to a browser that is already running.

## Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "browserglass": {
      "command": "node",
      "args": [
        "/path/to/browserglass/packages/cli/dist/bin.mjs",
        "mcp",
        "--endpoint", "http://127.0.0.1:7799",
        "--headless"
      ],
      "env": { "BGLS_DATA_DIR": "/path/to/browserglass/bgls-data" }
    }
  }
}
```

On Windows write the paths with forward slashes (`C:/src/browserglass/...`) or doubled backslashes.

## Three prompts to try

1. "Use the browserglass tools to open https://news.ycombinator.com, read the page, and give me the top five story titles with their points."
2. "Open five browsers at once with bg_swarm_open, send each one to a different Wikipedia article about a programming language (Python, Rust, Go, Haskell, Lisp), and tell me the year each language first appeared. Close the swarm when you are done."
3. "Go to https://httpbin.org/forms/post, fill in the pizza order form with made up details, choose a large pizza with onion, submit it, and show me what the server received."

The agent has to take the control lease (`bg_control` with `action: "acquire"`) before it can navigate or click. If it forgets, the tool error says so and names the call, and in practice the agent corrects itself on the next step.

While the agent works you can watch the same browser live from a page that embeds it, and take over with the mouse at any time. See scenarios 1 and 6 in the main README.

## What was checked

An MCP client spawned exactly the command above (with `BGLS_DATA_DIR` and no token), listed 41 tools, and called `bg_control`, `bg_navigate` and `bg_read_page` against news.ycombinator.com:

```
tool count: 41
bg_control: Control acquired, expires in 30s.
bg_navigate: Navigated to https://news.ycombinator.com/.
bg_read_page: Hacker News new | past | comments | ask | show | jobs | submit login ...
```

One thing to know: the browser `bgls mcp` opens at startup is still running after the MCP host disconnects. `pnpm bgls instances list` shows it and `pnpm bgls instances release <id> --force` ends it.
