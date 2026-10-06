const OFFICIAL_HOSTS = new Set(['mid.ebs.co.kr', 'cbox.ebs.co.kr', 'midwstr.ebs.co.kr', 'wstrmid.ebs.co.kr', 'wstr.ebs.co.kr', 'www.jje.go.kr', 'gice.gen.go.kr']);

export function officialUrl(value, base = 'https://cbox.ebs.co.kr') {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !OFFICIAL_HOSTS.has(url.hostname)) {
    throw new Error('허용된 공식 자료 주소가 아닙니다.');
  }
  return url.href;
}

// Bound the response as it is read, not after an untrusted download fills memory.
export async function download(value, { limit = 8 * 1024 * 1024, timeout = 18000, ...options } = {}) {
  let url = officialUrl(value);
  const signal = AbortSignal.timeout(timeout);
  for (let redirect = 0; redirect < 4; redirect++) {
    const response = await fetch(url, { ...options, signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = officialUrl(response.headers.get('location'), url);
      continue;
    }
    if (!response.ok) throw new Error(`공식 자료 다운로드 실패 (HTTP ${response.status})`);
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw new Error('자료 파일이 허용 크기를 초과합니다.');
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('자료 파일이 허용 크기를 초과합니다.');
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks), url, type: response.headers.get('content-type') || '' };
  }
  throw new Error('자료 다운로드 주소의 이동이 너무 많습니다.');
}
