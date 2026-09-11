import { describe, it, expect } from "bun:test";
import { extractTrackedCommands, formatTrackedCommands } from "../src/extract/tracked-commands";
import type { NormalizedBlock } from "../src/types";

const bash = (command: string): NormalizedBlock => ({
  kind: "tool_call",
  name: "bash",
  args: { command },
});

const TRACK = ["ssh", "kubectl", "docker", "aws"];

describe("extractTrackedCommands", () => {
  it("returns empty when trackCommands is empty (feature off)", () => {
    const act = extractTrackedCommands([bash("ssh example-host")], []);
    expect(act.byCommand.size).toBe(0);
  });

  it("captures a shallow one-liner per invocation, not a parsed structure", () => {
    const act = extractTrackedCommands([bash("kubectl get pods -n production")], TRACK);
    expect([...act.byCommand.get("kubectl")!]).toEqual(["kubectl get pods -n production"]);
  });

  it("only tracks command names explicitly configured", () => {
    const act = extractTrackedCommands([bash("kubectl get pods")], ["ssh"]);
    expect(act.byCommand.get("ssh")!.size).toBe(0);
    expect(act.byCommand.has("kubectl")).toBe(false);
  });

  it("cuts at the next real shell separator: semicolon, ampersand, pipe, and NEWLINE", () => {
    const act = extractTrackedCommands(
      [
        bash("docker restart web; echo done"),
        bash("docker restart api && echo ok"),
        bash("docker logs app | grep error"),
        bash("cd /app\ndocker ps\nkubectl get pods"),
      ],
      TRACK,
    );
    const docker = [...act.byCommand.get("docker")!];
    expect(docker).toContain("docker restart web");
    expect(docker).toContain("docker restart api");
    expect(docker).toContain("docker logs app");
    expect(docker).toContain("docker ps");
    expect([...act.byCommand.get("kubectl")!]).toContain("kubectl get pods");
    // None of the captured entries carry the separator itself.
    for (const entry of docker) expect(entry).not.toMatch(/[;&|]$/);
  });

  it("multiline bash blocks are fully scanned, not just the first line", () => {
    const act = extractTrackedCommands(
      [bash("cd /app\nssh prod-server 'docker restart web'\nkubectl get pods -n prod")],
      TRACK,
    );
    expect([...act.byCommand.get("ssh")!].length).toBeGreaterThan(0);
    expect([...act.byCommand.get("docker")!]).toContain("docker restart web");
    expect([...act.byCommand.get("kubectl")!]).toContain("kubectl get pods -n prod");
  });

  it("does not mistake ssh-keygen/docker-compose for real ssh/docker invocations", () => {
    const act = extractTrackedCommands(
      [bash("ssh-keygen -t ed25519 -f mykey"), bash("docker-compose up -d")],
      TRACK,
    );
    expect(act.byCommand.get("ssh")!.size).toBe(0);
    expect(act.byCommand.get("docker")!.size).toBe(0);
  });

  it("does not mistake quoted prose containing a tracked name for a real invocation", () => {
    const act = extractTrackedCommands([bash('echo "docker restart is flaky"')], TRACK);
    expect(act.byCommand.get("docker")!.size).toBe(0);
  });

  it("truncates very long entries", () => {
    const longArgs = "x".repeat(200);
    const act = extractTrackedCommands([bash(`aws ec2 ${longArgs}`)], TRACK);
    const entry = [...act.byCommand.get("aws")!][0];
    expect(entry.length).toBeLessThanOrEqual(85);
    expect(entry.endsWith("…")).toBe(true);
  });

  it("scans inside a QUOTED ssh remote-command string for other tracked names", () => {
    const act = extractTrackedCommands([bash('ssh prod-server "docker restart web"')], TRACK);
    expect([...act.byCommand.get("docker")!]).toContain("docker restart web");
  });

  it("scans inside an UNQUOTED ssh remote-command string for other tracked names", () => {
    const act = extractTrackedCommands([bash("ssh prod-server docker restart web")], TRACK);
    expect([...act.byCommand.get("docker")!]).toContain("docker restart web");
  });

  it("locates the ssh target by token position, not substring match (key-prod must not be mistaken for prod)", () => {
    const act = extractTrackedCommands([bash("ssh -i key-prod prod docker restart web")], TRACK);
    expect([...act.byCommand.get("docker")!]).toContain("docker restart web");
  });

  it("ignores non-bash tool calls entirely", () => {
    const act = extractTrackedCommands([{ kind: "tool_call", name: "read", args: { path: "a.ts" } }], TRACK);
    expect(act.byCommand.get("ssh")!.size).toBe(0);
  });
});

describe("formatTrackedCommands", () => {
  it("formats one line per command name that had a match, in insertion order", () => {
    const act = extractTrackedCommands([bash("ssh prod-server"), bash("docker ps")], ["ssh", "docker"]);
    expect(formatTrackedCommands(act)).toEqual(["ssh: ssh prod-server", "docker: docker ps"]);
  });

  it("omits command names with zero matches", () => {
    const act = extractTrackedCommands([bash("ssh prod-server")], ["ssh", "docker"]);
    expect(formatTrackedCommands(act)).toEqual(["ssh: ssh prod-server"]);
  });

  it("caps entries per command at 10 with an overflow marker", () => {
    const cmds = Array.from({ length: 12 }, (_, i) => bash(`ssh host${i}`));
    const act = extractTrackedCommands(cmds, ["ssh"]);
    const [line] = formatTrackedCommands(act);
    expect(line).toContain("(+2 more)");
  });
});
