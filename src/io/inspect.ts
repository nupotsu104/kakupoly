// 読み込めなかったファイルの中身を調べて、原因の手がかりを文章にする
export interface FileReport {
  lines: string[];
}

const ascii = (b: Uint8Array, n: number) => String.fromCharCode(...b.subarray(0, n));

export async function inspectModelFile(file: File): Promise<string[]> {
  const out: string[] = [`ファイル名: ${file.name}`, `大きさ: ${(file.size / 1024).toFixed(1)} KB`, `種類（端末の判定）: ${file.type || '不明'}`];
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  let kind = '不明';
  if (ascii(head, 4) === 'glTF') kind = 'GLB（glTF バイナリ）';
  else if (head[0] === 0x7b) kind = 'JSON（.gltf の可能性）';
  else if (ascii(head, 2) === 'PK') kind = 'ZIP（圧縮ファイル。展開してから中の .glb を選んでください）';
  else if (ascii(head, 18) === 'Kaydara FBX Binary') kind = 'FBX（バイナリ）';
  else if (/^(#|v |o |mtllib|g )/.test(new TextDecoder().decode(head))) kind = 'OBJ（テキスト）';
  else if (ascii(head, 4) === '<!DO' || ascii(head, 5) === '<html') kind = 'HTML（モデルではなくWebページ）';
  out.push(`中身から見た形式: ${kind}`);
  try {
    let json: Record<string, unknown> | null = null;
    if (ascii(head, 4) === 'glTF') {
      const buf = new Uint8Array(await file.slice(0, Math.min(file.size, 4 * 1024 * 1024)).arrayBuffer());
      const dv = new DataView(buf.buffer);
      out.push(`glTF バージョン: ${dv.getUint32(4, true)}`);
      const len = dv.getUint32(12, true);
      if (dv.getUint32(16, true) === 0x4e4f534a && 20 + len <= buf.length) json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + len)));
    } else if (head[0] === 0x7b && file.size < 50 * 1024 * 1024) json = JSON.parse(await file.text());
    if (json) {
      const asset = (json.asset ?? {}) as { generator?: string; version?: string };
      out.push(`作ったソフト: ${asset.generator ?? '記載なし'}`);
      const req = (json.extensionsRequired as string[] | undefined) ?? [];
      const used = (json.extensionsUsed as string[] | undefined) ?? [];
      if (req.length) out.push(`必須の拡張: ${req.join(', ')}`);
      if (used.length) out.push(`使っている拡張: ${used.join(', ')}`);
      const count = (k: string) => ((json![k] as unknown[] | undefined) ?? []).length;
      out.push(`中身: メッシュ${count('meshes')} ノード${count('nodes')} スキン${count('skins')} アニメ${count('animations')} 画像${count('images')}`);
      const ext = [...((json.buffers as { uri?: string }[] | undefined) ?? []), ...((json.images as { uri?: string }[] | undefined) ?? [])]
        .map((b) => b.uri)
        .filter((u): u is string => !!u && !u.startsWith('data:'));
      if (ext.length) out.push(`別ファイルが必要: ${ext.join(', ')}（一緒に選んでください）`);
    }
  } catch (e) {
    out.push(`中身の解析に失敗: ${(e as Error).message}`);
  }
  return out;
}
