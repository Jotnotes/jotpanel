# JotPanel MCP gateway

Every other panel lets your AI call tools. JotPanel lets your AI ask.

MCP is the cable. What your AI meets at the other end is **VACP™**, JotPanel's approval loop: it proposes, a person approves, JotPanel executes and reads the result back.

This zero-dependency Node.js 18+ gateway gives Claude Code, Cursor, Codex, or another MCP client the reads and proposal operations available to your own scoped JotPanel API key. Reads happen immediately. Changes do not: every change becomes a proposal, and nothing runs until a person approves it in JotPanel (or a separately issued `control.approve` key approves it outside this gateway).

The gateway can never approve, reject, or execute a proposal. It only reads the catalogue, performs catalogue reads, creates proposals, and reports proposal status.

## Install

From a copy of the JotPanel repository:

```sh
git clone https://github.com/Jotnotes/jotpanel.git
npm install --global ./jotpanel/app/mcp-gateway
```

That puts `jotpanel-mcp` on your path. It runs on your own computer, beside your AI, not on the server.

Set `JOTPANEL_URL` to your panel URL and `JOTPANEL_API_KEY` to a scoped API key. The key is sent only as the bearer credential to that panel and is never printed.

## Claude Code

```sh
claude mcp add --transport stdio --env JOTPANEL_URL=https://panel.example.com --env JOTPANEL_API_KEY=YOUR_SCOPED_KEY jotpanel -- jotpanel-mcp
```

## Cursor

Add this server to your Cursor MCP configuration:

```json
{
  "mcpServers": {
    "jotpanel": {
      "command": "jotpanel-mcp",
      "env": {
        "JOTPANEL_URL": "https://panel.example.com",
        "JOTPANEL_API_KEY": "YOUR_SCOPED_KEY"
      }
    }
  }
}
```

Use a key scoped only to the reads and operations you want the AI to see. Do not add `control.approve`: approval is deliberately outside this gateway.
