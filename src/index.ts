import axios from 'axios';
import xml2js from 'xml2js';
import { terminal as term } from 'terminal-kit';
import readline from 'readline';

interface URLStatus {
  url: string;
  status: number;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const sleep = async (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const ask = (question: string, def?: string | number): Promise<string> => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let questionStr = def ? `${question} (${def}): ` : `${question}*: `;
  return new Promise((resolve) => {
    rl.question(questionStr, (answer) => {
      rl.close();
      resolve(answer || String(def));
    });
  });
};

const validateAsk = async (
  question: string,
  def: string | number,
  validator: (input: string) => boolean
): Promise<string> => {
  let answer;
  do {
    answer = await ask(question, def);
  } while (!validator(answer));
  return answer;
};

const shuffle = <T>(array: T[]): T[] => {
  const newArray = [...array];
  let currentIndex = newArray.length;
  let temporaryValue: T;
  let randomIndex: number;

  // While there remain elements to shuffle...
  while (currentIndex !== 0) {
    // Pick a remaining element...
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;

    // And swap it with the current element.
    temporaryValue = newArray[currentIndex];
    newArray[currentIndex] = newArray[randomIndex];
    newArray[randomIndex] = temporaryValue;
  }

  return newArray;
};

const saveToFile = async (filename: string, data: string) => {
  const fs = require('fs');
  fs.writeFileSync(filename, data);
};

const fetchSitemap = async (url: string): Promise<string[]> => {
  const response = await axios.get(url);
  const parsed = await xml2js.parseStringPromise(response.data);
  return parsed.urlset.url.map((entry: any) => entry.loc[0]);
};

const non200Urls: URLStatus[] = [];
const parsedUrls: URLStatus[] = [];
const validateURL = async (url: string): Promise<URLStatus> => {
  try {
    const response = await axios.get(url);

    if (response.status !== 200) {
      non200Urls.push({ url, status: response.status });
    }

    parsedUrls.push({ url, status: response.status });
    return { url, status: response.status };
  } catch (error: any) {
    const status = error.response?.status || 500;
    non200Urls.push({ url, status });
    return { url, status };
  }
};

const updateProgress = (
  processed: number,
  total: number,
  url: string,
  status: number,
  statusCounts: Record<number, number>,
  urls: string[] = []
) => {
  term.clear();
  term.moveTo(1, 1);

  term.table(
    [
      ['Progress', 'Processed', 'Total', 'Last URL', 'Status'],
      [
        `${((processed / total) * 100).toFixed(2)}%`,
        String(processed),
        String(total),
        String(url),
        String(status),
      ],
    ],
    {
      hasBorder: true,
    }
  );

  const commonStatusCodes = ['200', '301', '302', '403', '404', '500'];

  term.table(
    [
      ['Status Codes'],
      ...commonStatusCodes.map((code) => [
        code,
        String(statusCounts[Number(code)] || 0),
      ]),
    ],
    {
      fit: true,
      hasBorder: true,
    }
  );

  term.table([['URLs in Queue'], ...urls.map((url) => [url])], {
    fit: true,
    hasBorder: true,
  });

  term.table(
    [
      ['Non-200 URLs'],
      ...non200Urls.map((entry) => [entry.url, String(entry.status)]),
    ],
    {
      fit: true,
      hasBorder: true,
    }
  );
};

let isPaused = false;

const askConfigurations = async () => {
  const sitemapUrl = await validateAsk(
    'Enter the URL of the sitemap',
    '',
    (input) => input.startsWith('http')
  );
  const concurrencyLimit = await validateAsk(
    'Enter the concurrency limit (must be > 0 and < 15)',
    '5',
    (input) => Number(input) > 0 && Number(input) < 15
  );
  const requestDelay = await validateAsk(
    'Enter the request delay in ms (must be > 250)',
    '1000',
    (input) => Number(input) > 250
  );
  const traversalOrder = await validateAsk(
    'Enter the traversal order (random/sequential)',
    'sequential',
    (input) => ['random', 'sequential'].includes(input)
  );

  return {
    sitemapUrl,
    concurrencyLimit,
    requestDelay,
    traversalOrder,
  };
};

const saveResults = async () => {
  const saveResults = await ask('Do you want to save the results? (Y/n)', 'Y');
  if (saveResults.toLowerCase() === 'y') {
    const non200fileName = await validateAsk(
      'Enter the filename to save non-200 URLs',
      'non200-urls.json',
      () => true
    );
    const parsedFileName = await validateAsk(
      'Enter the filename to save parsed URLs',
      'parsed-urls.json',
      () => true
    );

    await saveToFile(non200fileName, JSON.stringify(non200Urls, null, 2));
    await saveToFile(parsedFileName, JSON.stringify(parsedUrls, null, 2));

    term.green('Results saved. Exiting after 5 seconds... \n');
    await sleep(5000);
  }
};

const exit = async () => {
  term.clear();
  term.moveTo(1, 1);
  term.red('Exiting...\n');
  process.exit();
};

const main = async () => {
  const { sitemapUrl, concurrencyLimit, requestDelay, traversalOrder } =
    await askConfigurations();

  const urls = await fetchSitemap(sitemapUrl);
  if (traversalOrder === 'random') shuffle(urls);

  const total = urls.length;
  let processed = 0;
  const statusCounts: Record<number, number> = {};
  const urlQueue = [...urls];

  const workers: Promise<void>[] = [];

  const worker = async () => {
    while (urlQueue.length > 0) {
      if (isPaused) {
        await delay(1000);
        continue;
      }
      const url = urlQueue.shift();
      const nextUrls = urlQueue.slice(0, 5);

      if (url) {
        const result = await validateURL(url);
        processed++;
        statusCounts[result.status] = (statusCounts[result.status] || 0) + 1;
        updateProgress(
          processed,
          total,
          url,
          result.status,
          statusCounts,
          nextUrls
        );
        await delay(Number(requestDelay));
      }
    }
  };

  for (let i = 0; i < Number(concurrencyLimit); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  // We need to sleep to let the queue table catch up once the workers are done
  await sleep(2500);

  await saveResults();
};

// TODO: Add a way to pause the process, term.on is not working

main()
  .catch((error) => console.error('Error:', error))
  .finally(() => exit());
