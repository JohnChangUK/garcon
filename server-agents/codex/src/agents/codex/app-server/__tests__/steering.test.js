import fs from 'node:fs/promises';
import { describe, expect, it, mock } from 'bun:test';

import { steerCodexSession } from '../steering.js';

function steerableSession() {
  const steerTurn = mock(async () => ({ turnId: 'turn-1' }));
  return {
    threadId: 'thread-1',
    client: { steerTurn },
    activeDeliveryReservations: 0,
  };
}

function steerRequest(attachments) {
  return {
    chatId: 'chat-1',
    projectPath: '/repo',
    agentSessionId: 'thread-1',
    nativeSession: null,
    target: {},
    input: 'read the word in this screenshot',
    attachments,
    clientMessageId: 'message-1',
    prepareDelivery: async () => {},
  };
}

describe('steerCodexSession', () => {
  it('sends steering images as local images kept until the turn cleans up', async () => {
    const session = steerableSession();
    const turnCleanup = mock(async () => {});
    session.cleanupAttachments = turnCleanup;

    const result = await steerCodexSession(session, 'turn-1', steerRequest([{
      kind: 'image',
      name: 'word.png',
      mimeType: 'image/png',
      data: 'data:image/png;base64,iVBORw0KGgo=',
    }]), () => {});

    expect(result).toEqual({ kind: 'accepted' });
    const [params] = session.client.steerTurn.mock.calls[0];
    expect(params.input[0]).toEqual({
      type: 'text',
      text: 'read the word in this screenshot',
      text_elements: [],
    });
    expect(params.input[1]).toMatchObject({ type: 'localImage' });
    const imagePath = params.input[1].path;
    expect(await fs.readFile(imagePath)).toEqual(Buffer.from('iVBORw0KGgo=', 'base64'));

    await session.cleanupAttachments();
    expect(turnCleanup).toHaveBeenCalledTimes(1);
    await expect(fs.stat(imagePath)).rejects.toThrow();
  });

  it('leaves the turn cleanup alone for a text-only steer', async () => {
    const session = steerableSession();
    const turnCleanup = mock(async () => {});
    session.cleanupAttachments = turnCleanup;

    await steerCodexSession(session, 'turn-1', steerRequest([]), () => {});

    expect(session.cleanupAttachments).toBe(turnCleanup);
    expect(session.client.steerTurn.mock.calls[0][0].input).toEqual([{
      type: 'text',
      text: 'read the word in this screenshot',
      text_elements: [],
    }]);
  });
});
