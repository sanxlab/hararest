import { readResponseText } from '../utils/readResponse';

it('decodes UTF-8 split across chunks without corrupting multibyte characters', async () => {
  const encoded = new TextEncoder().encode('Hello 🌏');
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoded.slice(0, 8));
      controller.enqueue(encoded.slice(8));
      controller.close();
    },
  }));
  await expect(readResponseText(response, encoded.length)).resolves.toBe('Hello 🌏');
});

it('rejects declared oversized responses and cancels the body before reading it', async () => {
  const cancel = jest.fn();
  const response = new Response(new ReadableStream({ cancel }), {
    headers: { 'content-length': '1000' },
  });
  await expect(readResponseText(response, 100)).rejects.toMatchObject({ statusCode: 502 });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it.each([undefined, '1'])('caps actual bytes even with a missing or false content-length: %s', async (contentLength) => {
  const cancel = jest.fn();
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(60));
      controller.enqueue(new Uint8Array(60));
    },
    cancel,
  }), { headers: contentLength === undefined ? undefined : { 'content-length': contentLength } });
  await expect(readResponseText(response, 100)).rejects.toMatchObject({ statusCode: 502 });
  expect(cancel).toHaveBeenCalledTimes(1);
});
