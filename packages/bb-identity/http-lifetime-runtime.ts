export function retainIdentityHttpResponse(response: Response, invocationSignal: AbortSignal,
  requestSignal: AbortSignal, release: () => void): Response {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    invocationSignal.removeEventListener('abort', abort);
    requestSignal.removeEventListener('abort', abort);
    release();
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const abort = () => {
    if (settled) return;
    finish();
    stream?.error(new Error('Identity HTTP invocation expired.'));
    void reader?.cancel().catch(() => undefined);
  };
  if (!response.body) { finish(); return response; }
  reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
      invocationSignal.addEventListener('abort', abort, { once: true });
      requestSignal.addEventListener('abort', abort, { once: true });
      if (invocationSignal.aborted || requestSignal.aborted) abort();
    },
    async pull(controller) {
      if (settled) return;
      try {
        const item = await reader!.read();
        if (settled) return;
        if (item.done) { finish(); controller.close(); }
        else controller.enqueue(item.value);
      } catch (cause) {
        if (!settled) { finish(); controller.error(cause); }
      }
    },
    cancel(reason) { finish(); return reader!.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
