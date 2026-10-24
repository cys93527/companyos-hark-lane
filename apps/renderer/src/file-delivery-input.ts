/** Human input mapped onto the existing canonical fileDeliveries contract. Main validates it. */
export const fileDeliveryConstraints = async (relativePath: string, expectedContent: string): Promise<Readonly<Record<string, unknown>> | undefined> => {
  if (relativePath === '' && expectedContent === '') return undefined;
  if (relativePath === '' || relativePath.length > 240 || /[\\:]/u.test(relativePath) || [...relativePath].some(c => c.charCodeAt(0) < 32) || relativePath.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('文件路径必须是工作区内的相对路径。');
  const bytes = new TextEncoder().encode(expectedContent);
  if (bytes.length < 1 || bytes.length > 16384) throw new Error('期望内容必须为 1–16384 字节的 UTF-8 文本。');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const expectedSha256 = [...hash].map(v => v.toString(16).padStart(2, '0')).join('');
  return { fileDeliveries: [{ criterionId: 'file-delivery-1', relativePath, maxBytes: bytes.length, expectedSizeBytes: bytes.length, expectedSha256 }], fileDeliveryInput: { encoding: 'UTF-8', expectedContent } };
};
