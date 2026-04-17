import {config} from './config';

export type TranscriptionResponse = {
  text: string;
  lang: string;
};

export const transcribe = async (url: string) => {
  const res = await fetch(config.transcription.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.transcription.api_key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({url}),
  });

  if (!res.ok) {
    throw await res.text();
  }

  return res.json() as Promise<TranscriptionResponse>;
};
