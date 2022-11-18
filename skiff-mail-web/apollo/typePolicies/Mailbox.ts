import { FieldPolicy } from '@apollo/client';
import { ReadFieldFunction } from '@apollo/client/cache/core/types/common';
import { last, uniqBy } from 'lodash';
import { Mailbox, MailboxPageInfo, UserThread } from 'skiff-graphql';
import { assertExists } from 'skiff-utils';

const threadSortByDate = (readField: ReadFieldFunction) => (a: UserThread, b: UserThread) => {
  const aTime = readField<Date>('emailsUpdatedAt', a)?.getTime();
  const bTime = readField<Date>('emailsUpdatedAt', b)?.getTime();
  assertExists(aTime, `thread ${readField('threadID', a)} does not have a last updated time`);
  assertExists(bTime, `thread ${readField('threadID', b)} does not have a last updated time`);
  return bTime - aTime;
};

export const mailboxFieldPolicy: FieldPolicy<Mailbox> = {
  keyArgs: (args) =>
    JSON.stringify({
      // need to use a JSON.stringify function here instead of a normal array because we are including the Date scalar
      // which is just set to `{}` when stringified by Apollo
      label: args?.request?.label,
      filters: args?.request?.filters,
      emailsUpdatedAfterDate: args?.request?.emailsUpdatedAfterDate,
      emailsUpdatedBeforeDate: args?.request?.emailsUpdatedBeforeDate
    }),
  read: (existing, { readField }) =>
    existing ? { ...existing, threads: [...existing?.threads].sort(threadSortByDate(readField)) } : undefined,
  merge: (existing, incoming, { readField, args }) => {
    if (!existing) {
      return incoming;
    }
    if (!incoming) {
      return existing;
    }

    const existingThreadIDs = new Set(existing.threads.map((thread) => readField('threadID', thread)));

    // if incoming is the result of polling, we'll take all the new incoming threads and replace the existing threads.
    // (there may be no changes)
    if (args?.request.polling) {
      const combinedThreads = [...incoming.threads, ...existing.threads];
      const dedupedThreads = uniqBy(combinedThreads, (thread) => readField('threadID', thread));
      return { ...existing, threads: dedupedThreads, pageInfo: existing.pageInfo };
    }

    // if every thread in the incoming set of threads already exists, this means that its a
    // removal operation (ex: moving a thread to another system label)
    else if (
      incoming.threads.length < existing.threads.length &&
      incoming.threads.every((thread) => {
        const threadID = readField('threadID', thread);
        return !!threadID && existingThreadIDs.has(threadID);
      })
    ) {
      return { ...existing, threads: incoming.threads, pageInfo: incoming.pageInfo ?? existing.pageInfo };
    }

    // otherwise, the incoming set of threads are via pagination load more. in this case, we should combine the existing
    // threads and the incoming threads and make sure to dedup + sort by time
    else {
      const lastIncomingThread = last(incoming.threads);
      const lastExistingThread = last(existing.threads);

      // if the incoming threads are newer than the existing threads then it was fetched via polling, so we want to maintain the current pageInfo.
      // otherwise, the threads were fetched via pagination load more, so we want to update the pageInfo
      let pageInfo: MailboxPageInfo;
      if (
        lastIncomingThread &&
        lastExistingThread &&
        (readField<Date>('emailsUpdatedAt', lastIncomingThread)?.getTime() ?? 0) >
          (readField<Date>('emailsUpdatedAt', lastExistingThread)?.getTime() ?? 0)
      ) {
        pageInfo = existing.pageInfo;
      } else {
        pageInfo = incoming.pageInfo;
      }

      const combinedThreads = [...incoming.threads, ...existing.threads];
      const dedupedThreads = uniqBy(combinedThreads, (thread) => readField('threadID', thread));
      const sortedThreads = dedupedThreads.sort(threadSortByDate(readField));

      return {
        ...existing,
        threads: sortedThreads,
        pageInfo
      };
    }
  }
};
