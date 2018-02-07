import * as Fuse from 'fuse.js';
import * as child_process from 'child_process';
import * as path from 'path';
import * as memoize from 'memoizee';
import { ForkOptions } from "child_process";

// Error

export class OnePasswordNodeError extends Error {}
export class SessionError extends OnePasswordNodeError {}
export class QueryError extends OnePasswordNodeError {}

// Authentication

export type Credentials = {
  domain: string,
  email: string,
  secretKey: string,
  masterPassword: string,
}

export type Session = {
  token: string,
  expiresAt: Date,
}

export async function getSessionToken(credentials: Credentials): Promise<Session> {
  const { domain, email, secretKey, masterPassword } = credentials;

  try {
    const token = await exec(`signin ${domain} ${email} ${secretKey} ${masterPassword} --output=raw`, { raw: true });

    return {
      token,
      expiresAt: generateTokenExpirationDate(),
    }
  } catch (e) {
    return e;
  }
}

export function isValidSession(session: Session): boolean {
  return session.expiresAt.getTime() > Date.now();
}

// Account

export type Account = {
  uuid: string,
  name: string,
  avatarUrl: string,
  baseAvatarURL: string,
  createdAt: Date,
}

export const getAccount = memoize(async function(session: Session): Promise<Account> {
  const account = await exec('get account', { session });

  return {
    uuid: account.uuid,
    name: account.name,
    avatarUrl: `${account.baseAvatarURL}${account.uuid}/${account.avatar}`,
    baseAvatarURL: `${account.baseAvatarURL}${account.uuid}`,
    createdAt: new Date(account.createdAt),
  }
});

// User

export type User = {
  uuid: string,
  firstName: string,
  lastName: string,
  email: string,
  avatarUrl: string,
}

export type UserDetails = User & {
  language: string,
  createdAt: Date,
  updatedAt: Date,
  lastAuthAt: Date,
}

export const getUsers = memoize(async function(session: Session): Promise<User[]> {
  const users = await exec('list users', { session });
  const account = await getAccount(session);

  return users.map(function(user: User): User {
    const { uuid, firstName, lastName, email } = user;
    const avatarUrl = userAvatarUrl(user, account);

    return {
      uuid,
      firstName,
      lastName,
      email,
      avatarUrl,
    }
  });
});

export const getUser = memoize(async function(session: Session, id: string): Promise<UserDetails> {
  const user = await exec(`get user ${id}`, { session });
  const account = await getAccount(session);

  const { uuid, firstName, lastName, email, language,
    createdAt, updatedAt, lastAuthAt } = user;

  return {
    uuid,
    firstName,
    lastName,
    email,
    language,
    avatarUrl: userAvatarUrl(user, account),
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt),
    lastAuthAt: new Date(lastAuthAt),
  }
});

function userAvatarUrl(user: any, account: Account): string {
  return user.avatar.length > 0 ?
    `${account.baseAvatarURL}/${user.avatar}` :
    'https://a.1password.com/app/images/avatar-person-default.png';
}

// Template

export type Template = {
  uuid: string,
  name: string,
}

export const getTemplates = memoize(async function(session: Session): Promise<Template[]> {
  return await exec('list templates', { session });
});

// Vault

export type Vault = {
  uuid: string,
  name: string,
}

export type VaultDetails = Vault & {
  description: string,
  avatarUrl: string,
}

export async function getVaults(session: Session): Promise<Vault[]> {
  return await exec('list vaults', { session });
}

export const getVault = memoize(async function(session: Session, id: string): Promise<VaultDetails> {
  const vault = await exec(`get vault ${id}`, { session });
  const account = await getAccount(session);

  const { uuid, name, desc } = vault;
  const avatarUrl = vault.avatar.length > 0 ?
    `${account.baseAvatarURL}/${vault.avatar}` :
    'https://a.1password.com/app/images/avatar-vault-default.png';

  return {
    uuid,
    name,
    description: desc,
    avatarUrl,
  }
});

// Item

export type BaseItem = {
  uuid: string,
  vault: VaultDetails,
  template: Template,
  title: string,
}

export type LoginItem = BaseItem & {
  username: string,
  password?: string,
}

export type Item = BaseItem | LoginItem

export type ItemsOptions = {
  vault?: Vault,
  template?: Template,
  query?: string | undefined,
  fuse?: Fuse.FuseOptions,
}

const defaultItemsOptions = {
  vault: undefined,
  template: undefined,
  query: undefined,
  fuse: {}
};

export const getItems = memoize(async function(session: Session,
                                               options: ItemsOptions = defaultItemsOptions): Promise<Item[]> {
  const items = await exec('list items', { session, vault: options.vault });

  if (!options.query) return await trim(session, items, options.template) as Item[];

  const fuseOptions = Object.assign({
    shouldSort: true,
    threshold: 0.15,
    location: 0,
    distance: 100,
    maxPatternLength: 32,
    minMatchCharLength: 1,
    keys: [
      "uuid",
      "vaultUuid",
      "overview.ainfo",
      "overview.title",
      "overview.url",
    ]}, options.fuse);

  const filteredAccounts = new Fuse(items, fuseOptions).search(options.query);

  return await trim(session, filteredAccounts, options.template) as Item[];
});

export const getItem = memoize(async function(session: Session, id: string): Promise<Item> {
  const item = await exec(`get item ${id}`, { session });

  return await trim(session, item) as Item;
});

async function trim(session: Session, data: Array<any> | any, template: Template | undefined = undefined): Promise<Item[] | Item> {
  const format = async function(item: any) {
    const { uuid, vaultUuid, templateUuid, overview: { title } } = item;
    const vault = await getVault(session, vaultUuid);
    const templates = await getTemplates(session);
    const template = templates.find(function(template: Template) {
      return template.uuid === templateUuid;
    }) as Template;

    return Object.assign({},
      {
        uuid,
        vault,
        template,
        title,
      }, mapper(item, template));
  };

  if (Array.isArray(data)) {
    return await Promise.all(data
      .filter(function(item: any) {
        if (template) {
          return item.template.uuid === template.uuid;
        } else {
          return true;
        }
      })
      .map(async item => await format(item)));
  } else {
    return await format(data);
  }
}

function mapper(item: any, template: Template): any {
  switch(template.uuid) {
    // Login
    case '001':
      if (item.details && item.details.fields) {
        const passwordFieldFromName = item.details.fields.find(function(field: any) {
          return field.name.toLowerCase() === 'password' && field.type ===  'P';
        });
        const passwordFieldFromDesignation = item.details.fields.find(function(field: any) {
          return field.designation.toLowerCase() === 'password' && field.type === 'P';
        });

        const password = passwordFieldFromName ?
          passwordFieldFromName.value : (passwordFieldFromDesignation ? passwordFieldFromDesignation.value : undefined );

        return {
          username: item.overview.ainfo,
          password: password,
        };
      } else {
        return {
          username: item.overview.ainfo,
        };
      }
    default: {}
  }
}

// Engine

type ExecOptions = {
  session?: Session,
  vault?: Vault,
  raw?: boolean,
}

async function exec(command: string, options: ExecOptions = {}): Promise<any> {
  const defaultOptions: ExecOptions = { session: undefined, vault: undefined, raw: false };
  const { session, vault, raw } = Object.assign(defaultOptions, options);

  let args = command.split(' ');

  if (session) {
    if (isValidSession(session)) {
      args.push(`--session=${session.token}`);
    } else {
      throw new SessionError('Session invalid');
    }
  }

  if (vault) args.push(`--vault=${vault.name}`);

  const result = await forkBin(`${__dirname}/bin`, [opPath, args], { silent: true }) as string;

  // Error handling

  // [LOG] XXXX/XX/XX XX:XX:XX (ERROR) Item 3142134123412412 not found
  // [LOG] XXXX/XX/XX XX:XX:XX (ERROR) You are not currently signed in. Please run `op signin --help` for instructions
  // [LOG] XXXX/XX/XX XX:XX:XX (ERROR) 401: Authentication required.

  if (result.startsWith('[bin-error]')) {
    const error = result
      .split('---')[1]
      .split('(ERROR)')[1]
      .trim();

    if (error.includes('You are not currently signed in.') || '401: Authentication required') {
      throw new SessionError('Session invalid');
    } else {
      throw new QueryError(error);
    }
  }

  if (raw) return result;

  return JSON.parse(result);
}

async function forkBin(command: string, args: Array<any>, options: ForkOptions) {
  return new Promise((resolve, reject) => {
    let buffers: Buffer[] = [];

    const child = child_process.fork(command, args, options);

    if (child.stdout !== null) {
      child.stdout.on('data', data => {
        if (Buffer.isBuffer(data)) {
          buffers.push(data);
        } else if (typeof data === 'string') {
          buffers.push(Buffer.from(data, 'utf-8'));
        }
      });
    }

    child.on('close', () => {
      resolve(Buffer.concat(buffers).toString('utf-8').trim());
    });

    child.on('error', reject);
  });
}

function generateTokenExpirationDate(): Date {
  const now = new Date();
  return new Date(now.setMinutes(now.getMinutes() + 29));
}

const isDarwin = process.platform === 'darwin';

const opPath = isDarwin ?
  path.join(__dirname, '../ext/op-darwin-21001') :
  path.join(__dirname, '../ext/op-win-21001.exe');
