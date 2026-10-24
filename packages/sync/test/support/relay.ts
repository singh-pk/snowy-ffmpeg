// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// A MoQ relay for the browser tests: moq-dev's moq-relay in Docker, with a certificate
// made for the run. Chromium trusts it by its hash (`serverCertificateHashes`), which takes
// only an ECDSA certificate valid for at most 14 days, so none is kept in the repository. The
// files go into the container with `docker cp`, which works whatever the Docker host shares.
// On Colima, the relay is reached at the VM's address: start Colima with `--network-address`.

import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 0.17.8, built for linux/amd64 and linux/arm64.
const RELAY =
  "moqdev/moq-relay@sha256:e36365ebdc72337fb776241d80011ea05bed69c9540478ad79f7b14e6f85f450";
const ALPINE = "alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc";

// Prints the certificate, the key and the certificate's SHA-256, between markers.
const MAKE_CERTIFICATE = `
apk add -q openssl >/dev/null
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \\
  -keyout /tmp/key.pem -out /tmp/cert.pem -days 10 -subj /CN=snowy-relay 2>/dev/null
cat /tmp/cert.pem; echo '--split--'; cat /tmp/key.pem; echo '--split--'
openssl x509 -in /tmp/cert.pem -outform der | openssl dgst -sha256 -binary | base64
`;

// Runs a command, resolving with its output; rejects with its error output if it fails.
async function run(command: string[]) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(" ")}: ${err}`);
  return out.trim();
}

// The address the relay's published port is on: this machine's, or the VM's of the Colima
// profile Docker uses, whose context is `colima` or `colima-<profile>`.
async function host() {
  const context = await run(["docker", "context", "show"]);
  if (context !== "colima" && !context.startsWith("colima-")) return "127.0.0.1";

  const profile = context === "colima" ? "default" : context.slice("colima-".length);
  const status = await run(["colima", "status", "--profile", profile, "--json"]);
  const { ip_address: address }: { ip_address?: string } = JSON.parse(status);
  if (address === undefined || address === "")
    throw new Error("start Colima with --network-address for the relay tests");
  return address;
}

// Whether a log stream says the relay is listening, before it ends.
async function says(stream: ReadableStream<Uint8Array>, seen: { text: string }) {
  const decoder = new TextDecoder();

  for await (const chunk of stream) {
    seen.text += decoder.decode(chunk, { stream: true });
    if (seen.text.includes("listening")) return true;
  }

  return false;
}

// Resolves once the relay logs that it is listening, on either of its log streams.
async function running(name: string) {
  const logs = Bun.spawn(["docker", "logs", "-f", name], { stdout: "pipe", stderr: "pipe" });
  const seen = { text: "" };
  const started = await Promise.race([says(logs.stdout, seen), says(logs.stderr, seen)]);
  logs.kill();
  if (!started) throw new Error(`relay didn't start: ${seen.text}`);
}

/** Starts a relay; `stop` removes it. */
export async function startRelay() {
  const name = `snowy-relay-${crypto.randomUUID().slice(0, 8)}`;
  const made = await run([
    "docker",
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    ALPINE,
    "-c",
    MAKE_CERTIFICATE,
  ]);
  const [cert = "", key = "", hash = ""] = made.split("--split--\n");
  const dir = await mkdtemp(join(tmpdir(), "snowy-relay-"));
  await Bun.write(join(dir, "cert.pem"), cert);
  await Bun.write(join(dir, "key.pem"), key);
  // The relay runs as a user other than the file's owner.
  await chmod(join(dir, "key.pem"), 0o644);

  await run([
    "docker",
    "create",
    "--name",
    name,
    "-p",
    "4433/udp",
    RELAY,
    "--listen",
    "0.0.0.0:4433",
    "--listen-tls-cert",
    "/tmp/cert.pem",
    "--listen-tls-key",
    "/tmp/key.pem",
    // Anyone may publish and subscribe anywhere, until the tests bring an auth server.
    "--auth-public",
    "**",
  ]);
  const stop = () => run(["docker", "rm", "-f", name]);

  try {
    await run(["docker", "cp", join(dir, "cert.pem"), `${name}:/tmp/cert.pem`]);
    await run(["docker", "cp", join(dir, "key.pem"), `${name}:/tmp/key.pem`]);
    await run(["docker", "start", name]);
    await running(name);
    const mapped = await run(["docker", "port", name, "4433/udp"]);
    const port = mapped.split("\n")[0]?.split(":").at(-1);
    const address = await host();
    return { url: `https://${address}:${port}`, hash: hash.trim(), stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    await rm(dir, { recursive: true });
  }
}
