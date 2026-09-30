export function scheduledJobFormProblem(job = {}) {
  const name = String(job.name || "").trim();
  if (name.length < 2 || name.length > 120) return "Use a job name between 2 and 120 characters.";

  const schedule = String(job.schedule || "").trim();
  if (!schedule) return "Enter a schedule.";
  const fields = schedule.split(/\s+/);
  if (fields.length !== 5) {
    return "Use five cron fields: minute, hour, day, month, weekday.";
  }
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  for (let index = 0; index < fields.length; index += 1) {
    if (!validCronField(fields[index], ...ranges[index])) return `Check cron field ${index + 1}: ${fields[index]}.`;
  }

  if (String(job.note || "").trim().length > 500) return "Keep the note to 500 characters or fewer.";
  const command = String(job.command || "").trim();
  if (!command) return "Enter the command to run.";
  if (command.length > 4000 || /[\0\r\n]/.test(command)) return "Keep the command to one line and 4,000 characters or fewer.";
  return "";
}

function validCronField(field, min, max) {
  return field.split(",").every(segment => {
    const parts = segment.split("/");
    if (parts.length > 2) return false;
    const [base, rawStep] = parts;
    const step = rawStep == null ? 1 : Number(rawStep);
    if (!Number.isInteger(step) || step < 1 || step > max - min + 1) return false;
    if (base === "*") return true;
    if (/^\d+$/.test(base)) {
      const value = Number(base);
      return value >= min && value <= max;
    }
    const match = base.match(/^(\d+)-(\d+)$/);
    if (!match) return false;
    const start = Number(match[1]);
    const end = Number(match[2]);
    return start >= min && end <= max && start <= end;
  });
}

export function scheduledJobRunTone(status) {
  if (status === "succeeded") return "ok";
  if (status === "running") return "info";
  if (status === "failed" || status === "timed_out") return "bad";
  return "neutral";
}

export function filterControlActions(rows = [], { query = "", status = "all" } = {}) {
  const needle = String(query).trim().toLowerCase();
  return rows.filter(row => {
    if (status !== "all" && row.status !== status) return false;
    if (!needle) return true;
    return [row.label, row.summary, row.error, row.kind, row.id]
      .some(value => String(value || "").toLowerCase().includes(needle));
  });
}

export function filterAuditRows(rows = [], { query = "", action = "all" } = {}) {
  const needle = String(query).trim().toLowerCase();
  return rows.filter(row => {
    if (action !== "all" && row.action !== action) return false;
    if (!needle) return true;
    return [row.ts, row.user_id, row.action, row.details, row.ip]
      .some(value => String(value || "").toLowerCase().includes(needle));
  });
}

export function auditRowsToCsv(rows = []) {
  const cell = value => {
    let text = String(value ?? "");
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const header = ["Timestamp", "Account", "Action", "Details", "IP address"];
  const body = rows.map(row => [row.ts, row.user_id, row.action, row.details, row.ip]);
  return [header, ...body].map(values => values.map(cell).join(",")).join("\n") + "\n";
}

export const APPLICATION_UI = Object.freeze({
  wordpress: Object.freeze({
    icon: "globe",
    description: "Website publishing and content management.",
    parameters: Object.freeze(["site domain", "database"]),
  }),
  phpmyadmin: Object.freeze({
    icon: "storage",
    description: "Browser administration for MariaDB and MySQL.",
    parameters: Object.freeze(["site domain", "database service"]),
  }),
});
