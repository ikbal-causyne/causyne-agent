/** Keep an opened conversation anchored to the terminal bottom at every width. */
export function sessionStageHeight(maxHeight, promptRows, contentRows, fullSession) {
    const limit = Math.max(1, Math.floor(maxHeight));
    return fullSession ? limit : Math.min(limit, Math.max(1, promptRows + contentRows));
}
/** Place a short transcript beside the input; spare space belongs above it. */
export function alignTranscriptRows(rows, contentRows) {
    const visible = Math.max(0, Math.min(rows.length, Math.floor(contentRows)));
    if (visible === rows.length)
        return rows;
    return Array(rows.length - visible).fill('').concat(rows.slice(0, visible));
}
