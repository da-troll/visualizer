declare module 'jsmediatags' {
  interface PictureTag {
    format: string;
    data: number[];
  }
  interface Tags {
    title?: string;
    artist?: string;
    album?: string;
    picture?: PictureTag;
  }
  interface TagResult { tags: Tags }
  interface Callbacks {
    onSuccess: (r: TagResult) => void;
    onError: (e: { type: string; info: string }) => void;
  }
  function read(source: File | Blob | string, callbacks: Callbacks): void;
  export default { read };
}
