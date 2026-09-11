import { api } from './api';

export type UploadStep = 'presigning' | 'uploading' | 'finalizing' | 'done' | 'failed';

type Ticket = { assetId: string; uploadUrl: string; headers: Record<string, string> };

// The three-call upload. The bytes go straight to the bucket; the API only
// hands out the URL and then goes to look at what landed.
export async function uploadFile(
  galleryId: string,
  file: File,
  onStep: (step: UploadStep) => void,
): Promise<string> {
  onStep('presigning');
  const ticket = await api.post<Ticket>(`/api/galleries/${galleryId}/uploads`, {
    filename: file.name,
    size: file.size,
    contentType: file.type,
  });

  // content-length is a forbidden header in fetch; the browser sets it from
  // the body, and it has to match the size declared above or the signature fails.
  onStep('uploading');
  const put = await fetch(ticket.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': ticket.headers['content-type'] },
    body: file,
  });
  if (!put.ok) throw new Error(`Storage rejected the upload (${put.status}).`);

  onStep('finalizing');
  await api.post(`/api/uploads/${ticket.assetId}/finalize`);
  onStep('done');

  return ticket.assetId;
}
