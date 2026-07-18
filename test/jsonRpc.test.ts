import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { JsonRpcPeer } from "../src/jsonRpc";

class CaptureWriter extends Writable {
  readonly lines: string[] = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.lines.push(chunk.toString());
    callback();
  }
}

test("JsonRpcPeer resolves split response frames", async () => {
  const writer = new CaptureWriter();
  const peer = new JsonRpcPeer(writer);
  const pending = peer.sendRequest<{ ok: boolean }>("initialize", { protocolVersion: 1 });

  assert.equal(writer.lines.length, 1);
  const sent = JSON.parse(writer.lines[0]);
  assert.equal(sent.method, "initialize");
  assert.equal(sent.id, 1);

  peer.handleData('{"jsonrpc":"2.0","id":1,');
  peer.handleData('"result":{"ok":true}}\n');
  assert.deepEqual(await pending, { ok: true });
});

test("JsonRpcPeer answers inbound requests", async () => {
  const writer = new CaptureWriter();
  const peer = new JsonRpcPeer(writer, {
    onRequest: (method, params) => {
      assert.equal(method, "session/request_permission");
      assert.deepEqual(params, { id: "p1" });
      return { outcome: { outcome: "cancelled" } };
    },
  });

  peer.handleData('{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{"id":"p1"}}\n');

  await tick();
  assert.equal(writer.lines.length, 1);
  const response = JSON.parse(writer.lines[0]);
  assert.equal(response.id, 9);
  assert.deepEqual(response.result, { outcome: { outcome: "cancelled" } });
});

test("JsonRpcPeer rejects pending requests on close", async () => {
  const writer = new CaptureWriter();
  const peer = new JsonRpcPeer(writer);
  const pending = peer.sendRequest("session/prompt", {});
  peer.close(new Error("closed for test"));
  await assert.rejects(pending, /closed for test/);
});

test("JsonRpcPeer reports notification handler failures", async () => {
  const writer = new CaptureWriter();
  const errors: Error[] = [];
  const peer = new JsonRpcPeer(writer, {
    onNotification: () => { throw new Error("notification failed"); },
    onError: (err) => errors.push(err),
  });

  peer.handleData('{"jsonrpc":"2.0","method":"session/update","params":{}}\n');
  await tick();

  assert.equal(errors[0]?.message, "notification failed");
});

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
