import { shelvedFor } from "/home/user/TuvaVideos/src/server/reconcile";
const base = { title: "T", titleLatin: null, songId: null, versionId: null, artistIds: [], chapters: [] } as any;
console.log(JSON.stringify(shelvedFor({ ...base, type: "song" }, { ...base, type: "concert" }).shelved));
console.log(JSON.stringify(shelvedFor({ ...base, type: "other" }, { ...base, type: "concert" }).shelved));
