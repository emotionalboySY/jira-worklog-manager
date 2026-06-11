// 에디터 mount element에 부착하는 첨부 메타/blob URL 관리 헬퍼.
// 파사드(tiptap.js)와 본체(tiptapEditor.js) 양쪽에서 쓰이며, @tiptap 의존이 없어
// 초기 번들에 포함돼도 비용이 없다. (tiptapMedia.js에서 분리)

// 마운트에 첨부 메타를 미리 주입 (편집 진입 시 호출).
// 옛 이슈는 ADF media.attrs.id가 Media Services UUID라 첨부 numeric id와 매칭이
// 안 됨 → 파일명 인덱스도 함께 만들어 NodeView가 폴백 매칭하도록 한다.
export function setMountAttachments(mountEl, attachments) {
  if (!mountEl) return
  const map = {}
  const byName = {}
  for (const a of attachments || []) {
    if (!a?.id && !a?.mediaId) continue
    const entry = { contentUrl: a.contentUrl || '', filename: a.filename || '' }
    if (a.id) map[String(a.id)] = entry
    // ADF media.attrs.id에는 보통 Media Services UUID가 들어가므로 mediaId 키로도 인덱싱
    if (a.mediaId) map[String(a.mediaId)] = entry
    if (a.filename && !byName[a.filename]) byName[a.filename] = entry
  }
  mountEl.__tt_attachments_by_id = map
  mountEl.__tt_attachments_by_filename = byName
}

// 에디터 파괴 시 같이 호출해 blob URL 일괄 해제
export function releaseMountBlobUrls(mountEl) {
  if (!mountEl) return
  for (const url of mountEl.__tt_owned_blob_urls || []) {
    try { URL.revokeObjectURL(url) } catch {}
  }
  mountEl.__tt_owned_blob_urls = null
  mountEl.__tt_temp_blob_urls = null
}
