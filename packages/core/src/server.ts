import { bytesToHex } from "./encoding";
import {
    API,
    RequestEmailVerificationParams,
    CompleteEmailVerificationParams,
    InitAuthParams,
    InitAuthResponse,
    CreateAccountParams,
    RecoverAccountParams,
    CreateSessionParams,
    GetInviteParams,
    GetAttachmentParams,
    DeleteAttachmentParams
} from "./api";
import { Storage } from "./storage";
import { Attachment, AttachmentStorage } from "./attachment";
import { Session, SessionID } from "./session";
import { Account } from "./account";
import { Auth } from "./auth";
import { EmailVerification } from "./email-verification";
import { Request, Response } from "./transport";
import { Err, ErrorCode } from "./error";
import { Vault, VaultID } from "./vault";
import { Org, OrgID, OrgRole } from "./org";
import { Invite } from "./invite";
import { Messenger } from "./messenger";
import { Server as SRPServer } from "./srp";
import { DeviceInfo } from "./platform";
import { uuid } from "./util";
import { EmailVerificationMessage, InviteCreatedMessage, InviteAcceptedMessage, MemberAddedMessage } from "./messages";
import { localize as $l } from "./locale";
import { BillingProvider, UpdateBillingParams } from "./billing";

const pendingAuths = new Map<string, SRPServer>();

/** Server configuration */
export interface ServerConfig {
    /** URL where the client interface is hosted. Used for creating links into the application */
    clientUrl: string;
    /** Email address to report critical errors to */
    reportErrors: string;
}

/**
 * Request context
 */
export interface Context {
    /** Current [[Session]] */
    session?: Session;

    /** [[Account]] associated with current session */
    account?: Account;

    /** Information about the device the request is coming from */
    device?: DeviceInfo;
}

/**
 * Controller class for processing api requests
 */
class Controller implements API {
    constructor(
        public context: Context,
        /** Server config */
        public config: ServerConfig,
        /** Storage for persisting data */
        public storage: Storage,
        /** [[Messenger]] implemenation for sending messages to users */
        public messenger: Messenger,
        /** Attachment storage */
        public attachmentStorage: AttachmentStorage,
        public billingProvider?: BillingProvider
    ) {}

    async requestEmailVerification({ email, purpose }: RequestEmailVerificationParams) {
        const v = new EmailVerification(email, purpose);
        await v.init();
        await this.storage.save(v);
        this.messenger.send(email, new EmailVerificationMessage(v));
    }

    async completeEmailVerification({ email, code }: CompleteEmailVerificationParams) {
        return await this._checkEmailVerificationCode(email, code);
    }

    async initAuth({ email, verify }: InitAuthParams): Promise<InitAuthResponse> {
        let auth: Auth | null = null;

        try {
            auth = await this.storage.get(Auth, email);
        } catch (e) {
            if (e.code !== ErrorCode.NOT_FOUND) {
                throw e;
            }
        }

        const deviceTrusted =
            auth && this.context.device && auth.trustedDevices.some(({ id }) => id === this.context.device!.id);

        if (!deviceTrusted) {
            if (!verify) {
                throw new Err(ErrorCode.EMAIL_VERIFICATION_REQUIRED);
            } else {
                this._checkEmailVerificationToken(email, verify);
            }
        }

        if (!auth) {
            // The user has successfully verified their email address so it's safe to
            // tell them that this account doesn't exist.
            throw new Err(ErrorCode.NOT_FOUND, "An account with this email does not exist!");
        }

        // Initiate SRP key exchange using the accounts verifier. This also
        // generates the random `B` value which will be passed back to the
        // client.
        const srp = new SRPServer();
        await srp.initialize(auth.verifier!);

        // Store SRP context so it can be picked back up in [[createSession]]
        pendingAuths.set(auth.account, srp);

        return new InitAuthResponse({
            auth,
            B: srp.B!
        });
    }

    async updateAuth(auth: Auth): Promise<void> {
        const { account } = this._requireAuth();

        // Auth information can only be updated by the corresponding account
        if (account.email !== auth.email) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        await this.storage.save(auth);
    }

    async createSession({ account, A, M }: CreateSessionParams): Promise<Session> {
        // Get the pending SRP context for the given account
        const srp = pendingAuths.get(account);

        if (!srp) {
            throw new Err(ErrorCode.INVALID_CREDENTIALS);
        }

        // Apply `A` received from the client to the SRP context. This will
        // compute the common session key and verification value.
        await srp.setA(A);

        // Verify `M`, which is the clients way of proving that they know the
        // accounts master password. This also guarantees that the session key
        // computed by the client and server are identical an can be used for
        // authentication.
        if (bytesToHex(M) !== bytesToHex(srp.M1!)) {
            throw new Err(ErrorCode.INVALID_CREDENTIALS);
        }

        // Fetch the account in question
        const acc = await this.storage.get(Account, account);

        // Create a new session object
        const session = new Session();
        session.id = await uuid();
        session.account = account;
        session.device = this.context.device;
        session.key = srp.K!;

        // Add the session to the list of active sessions
        acc.sessions.push(session);

        // Persist changes
        await Promise.all([this.storage.save(session), this.storage.save(acc)]);

        // Delete pending SRP context
        pendingAuths.delete(account);

        // Add device to trusted devices
        const auth = await this.storage.get(Auth, acc.email);
        if (this.context.device && !auth.trustedDevices.some(({ id }) => id === this.context.device!.id)) {
            auth.trustedDevices.push(this.context.device);
        }
        await this.storage.save(auth);

        // Although the session key is secret in the sense that it should never
        // be transmitted between client and server, it still needs to be
        // stored on both sides, which is why it is included in the [[Session]]
        // classes serialization. So we have to make sure to remove the key
        // explicitly before returning.
        delete session.key;

        return session;
    }

    async revokeSession(id: SessionID) {
        const { account } = this._requireAuth();

        const session = await this.storage.get(Session, id);

        if (session.account !== account.id) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        const i = account.sessions.findIndex(s => s.id === id);
        account.sessions.splice(i, 1);

        await Promise.all([this.storage.delete(session), this.storage.save(account)]);
    }

    async createAccount({ account, auth, verify }: CreateAccountParams): Promise<Account> {
        await this._checkEmailVerificationToken(account.email, verify);

        // Make sure account does not exist yet
        try {
            await this.storage.get(Auth, auth.id);
            throw new Err(ErrorCode.ACCOUNT_EXISTS, "This account already exists!");
        } catch (e) {
            if (e.code !== ErrorCode.NOT_FOUND) {
                throw e;
            }
        }

        // Most of the account object is constructed locally but account id and
        // revision are exclusively managed by the server
        account.id = await uuid();
        account.revision = await uuid();
        auth.account = account.id;

        // Add device to trusted devices
        if (this.context.device && !auth.trustedDevices.some(({ id }) => id === this.context.device!.id)) {
            auth.trustedDevices.push(this.context.device);
        }

        // Provision the private vault for this account
        const vault = new Vault();
        vault.id = await uuid();
        vault.name = "My Vault";
        vault.owner = account.id;
        vault.created = new Date();
        vault.updated = new Date();
        account.mainVault = vault.id;

        // Persist data
        await Promise.all([this.storage.save(account), this.storage.save(vault), this.storage.save(auth)]);

        return account;
    }

    async getAccount() {
        const { account } = this._requireAuth();
        return account;
    }

    async updateAccount({ name, email, publicKey, keyParams, encryptionParams, encryptedData, revision }: Account) {
        const { account } = this._requireAuth();

        // Check the revision id to make sure the changes are based on the most
        // recent version stored on the server. This is to ensure continuity in
        // case two clients try to make changes to an account at the same time.
        if (revision !== account.revision) {
            throw new Err(ErrorCode.OUTDATED_REVISION);
        }

        // Update revision id
        account.revision = await uuid();

        const nameChanged = account.name !== name;

        // Update account object
        Object.assign(account, { name, email, publicKey, keyParams, encryptionParams, encryptedData });

        // Persist changes
        account.updated = new Date();
        await this.storage.save(account);

        // If the accounts name has changed, well need to update the
        // corresponding member object on all organizations this account is a
        // member of.
        if (nameChanged) {
            for (const id of account.orgs) {
                const org = await this.storage.get(Org, id);
                org.getMember(account)!.name = name;
                await this.storage.save(org);
            }
        }

        return account;
    }

    async recoverAccount({
        account: { email, publicKey, keyParams, encryptionParams, encryptedData },
        auth,
        verify
    }: RecoverAccountParams) {
        // Check the email verification token
        await this._checkEmailVerificationToken(auth.email, verify);

        // Find the existing auth information for this email address
        const existingAuth = await this.storage.get(Auth, auth.email);

        // Fetch existing account
        const account = await this.storage.get(Account, existingAuth.account);

        // Update account object
        Object.assign(account, { email, publicKey, keyParams, encryptionParams, encryptedData });

        // Create a new private vault, discarding the old one
        const mainVault = new Vault();
        mainVault.id = account.mainVault;
        mainVault.name = $l("My Vault");
        mainVault.owner = account.id;
        mainVault.created = new Date();
        mainVault.updated = new Date();

        // The new auth object has all the information except the account id
        auth.account = account.id;
        this.context.device && auth.trustedDevices.push(this.context.device);

        // Revoke all sessions
        await account.sessions.map(s => this.storage.delete(Object.assign(new Session(), s)));

        // Suspend memberships for all orgs that the account is not the owner of.
        // Since the accounts public key has changed, they will need to go through
        // the invite flow again to confirm their membership.
        for (const id of account.orgs) {
            const org = await this.storage.get(Org, id);
            if (!org.isOwner(account)) {
                const member = org.getMember(account)!;
                member.role = OrgRole.Suspended;
                await this.storage.save(org);
            }
        }

        // Persist changes
        await Promise.all([this.storage.save(account), this.storage.save(auth), this.storage.save(mainVault)]);

        return account;
    }

    async createOrg(org: Org) {
        const { account } = this._requireAuth();

        if (!org.name) {
            throw new Err(ErrorCode.BAD_REQUEST, "Please provide an organization name!");
        }

        const existingOrgs = await Promise.all(account.orgs.map(id => this.storage.get(Org, id)));
        const ownedOrgs = existingOrgs.filter(o => o.owner === account.id);

        if (account.quota.orgs !== -1 && ownedOrgs.length >= account.quota.orgs) {
            throw new Err(ErrorCode.QUOTA_EXCEEDED);
        }

        org.id = await uuid();
        org.revision = await uuid();
        org.owner = account.id;

        await this.storage.save(org);

        return org;
    }

    async getOrg(id: OrgID) {
        const { account } = this._requireAuth();

        const org = await this.storage.get(Org, id);

        // Only members can read organization data. For non-members,
        // we pretend the organization doesn't exist.
        if (org.owner !== account.id && !org.isMember(account)) {
            throw new Err(ErrorCode.NOT_FOUND);
        }

        return org;
    }

    async updateOrg({
        id,
        name,
        publicKey,
        keyParams,
        encryptionParams,
        encryptedData,
        signingParams,
        accessors,
        members,
        groups,
        vaults,
        invites,
        revision
    }: Org) {
        const { account } = this._requireAuth();

        // Get existing org based on the id
        const org = await this.storage.get(Org, id);

        // Check the revision id to make sure the changes are based on the most
        // recent version stored on the server. This is to ensure continuity in
        // case two clients try to make changes to an organization at the same
        // time.
        if (revision !== org.revision) {
            throw new Err(ErrorCode.OUTDATED_REVISION);
        }

        const isOwner = org.owner === account.id || org.isOwner(account);
        const isAdmin = isOwner || org.isAdmin(account);

        // Only admins can make any changes to organizations at all.
        if (!isAdmin) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS, "Only admins can make changes to organizations!");
        }

        const addedMembers = members.filter(m => !org.isMember(m));
        const removedMembers = org.members.filter(({ id }) => !members.some(m => id === m.id));
        const addedInvites = invites.filter(({ id }) => !org.getInvite(id));

        // Only org owners can add or remove members, change roles or create invites
        if (
            !isOwner &&
            (addedMembers.length ||
                removedMembers.length ||
                addedInvites.length ||
                members.some(({ id, role }) => {
                    const member = org.getMember({ id });
                    return !member || member.role !== role;
                }))
        ) {
            throw new Err(
                ErrorCode.INSUFFICIENT_PERMISSIONS,
                "Only organization owners can add or remove members, change roles or create invites!"
            );
        }

        // New invites
        for (const invite of addedInvites) {
            let link = `${this.config.clientUrl}/invite/${org.id}/${invite.id}`;

            // If account does not exist yet, create a email verification code
            // and send it along with the url so they can skip that step
            try {
                await this.storage.get(Auth, invite.email);
            } catch (e) {
                if (e.code !== ErrorCode.NOT_FOUND) {
                    throw e;
                }
                // account does not exist yet; add verification code to link
                const v = new EmailVerification(invite.email);
                await v.init();
                await this.storage.save(v);
                link += `?verify=${v.token}&email=${invite.email}`;
            }

            // Send invite link to invitees email address
            this.messenger.send(invite.email, new InviteCreatedMessage(invite, link));
        }

        // Removed members
        for (const { id } of removedMembers) {
            const acc = await this.storage.get(Account, id);
            acc.orgs = acc.orgs.filter(id => id !== org.id);
            await this.storage.save(acc);
        }

        // Update any changed vault names
        for (const { id, name } of org.vaults) {
            const newVaultEntry = vaults.find(v => v.id === id);
            if (newVaultEntry && newVaultEntry.name !== name) {
                const vault = await this.storage.get(Vault, id);
                vault.name = newVaultEntry.name;
                await this.storage.save(vault);
            }
        }

        Object.assign(org, {
            members,
            groups,
            vaults
        });

        // certain properties may only be updated by organization owners
        if (isOwner) {
            Object.assign(org, {
                name,
                publicKey,
                keyParams,
                encryptionParams,
                encryptedData,
                signingParams,
                accessors,
                invites
            });
        }

        // Check members quota
        if (
            (org.quota.members !== -1 && members.length > org.quota.members) ||
            (org.quota.groups !== -1 && groups.length > org.quota.groups)
        ) {
            throw new Err(ErrorCode.QUOTA_EXCEEDED);
        }

        // Added members
        for (const member of addedMembers) {
            const acc = await this.storage.get(Account, member.id);
            acc.orgs.push(org.id);
            await this.storage.save(acc);

            if (member.id !== account.id) {
                // Send a notification email to let the new member know they've been added
                this.messenger.send(
                    member.email,
                    new MemberAddedMessage(org, `${this.config.clientUrl}/org/${org.id}`)
                );
            }
        }

        // Update revision
        org.revision = await uuid();

        await this.storage.save(org);

        return org;
    }

    async getVault(id: VaultID) {
        const { account } = this._requireAuth();

        const vault = await this.storage.get(Vault, id);
        const org = vault.org && (await this.storage.get(Org, vault.org.id));

        // Accounts can only read their private vaults and vaults they have been assigned to
        // on an organization level. For everyone else, pretend like the vault doesn't exist.
        if ((org && !org.canRead(vault, account)) || (!org && vault.owner !== account.id)) {
            throw new Err(ErrorCode.NOT_FOUND);
        }

        return vault;
    }

    async updateVault({ id, keyParams, encryptionParams, accessors, encryptedData, revision }: Vault) {
        const { account } = this._requireAuth();

        const vault = await this.storage.get(Vault, id);
        const org = vault.org && (await this.storage.get(Org, vault.org.id));

        // Accounts can only read their private vaults and vaults they have been assigned to
        // on an organization level. For everyone else, pretend like the vault doesn't exist.
        if ((org && !org.canRead(vault, account)) || (!org && vault.owner !== account.id)) {
            throw new Err(ErrorCode.NOT_FOUND);
        }

        // Vaults can only be updated by accounts that have explicit write access
        if (org && !org.canWrite(vault, account)) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        // Check the revision id to make sure the changes are based on the most
        // recent version stored on the server. This is to ensure continuity in
        // case two clients try to make changes to an organization at the same
        // time.
        if (revision !== vault.revision) {
            throw new Err(ErrorCode.OUTDATED_REVISION);
        }
        vault.revision = await uuid();

        // Update vault properties
        Object.assign(vault, { keyParams, encryptionParams, accessors, encryptedData });
        vault.updated = new Date();

        // Persist changes
        await this.storage.save(vault);

        return vault;
    }

    async createVault(vault: Vault) {
        const { account } = this._requireAuth();

        // Explicitly creating vaults only works in the context of an
        // organization (private vaults are created automatically)
        if (!vault.org) {
            throw new Err(ErrorCode.BAD_REQUEST, "Shared vaults have to be attached to an organization.");
        }

        const org = await this.storage.get(Org, vault.org.id);

        // Only admins can create new vaults for an organization
        if (!org.isAdmin(account)) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        // Create vault object
        vault.id = await uuid();
        vault.owner = account.id;
        vault.created = vault.updated = new Date();
        vault.revision = await uuid();

        // Add to organization
        org.vaults.push({ id: vault.id, name: vault.name });
        org.revision = await uuid();

        // Check vault quota of organization
        if (org.quota.vaults !== -1 && org.vaults.length > org.quota.vaults) {
            throw new Err(ErrorCode.QUOTA_EXCEEDED);
        }

        // Persist cahnges
        await Promise.all([this.storage.save(vault), this.storage.save(org)]);

        return vault;
    }

    async deleteVault(id: VaultID) {
        const { account } = this._requireAuth();

        const vault = await this.storage.get(Vault, id);

        // Only vaults that have been created in the context of an
        // organization can be deleted (private vaults are managed
        // by the server implicitly)
        if (!vault.org) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        const org = await this.storage.get(Org, vault.org.id);

        // Only org admins can delete vaults
        if (!org.isAdmin(account)) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        // Delete vault
        const promises = [this.storage.delete(vault)];

        // Delete all attachments associated with this vault
        promises.push(this.attachmentStorage.deleteAll(vault.id));

        // Remove vault from org
        org.vaults = org.vaults.filter(v => v.id !== vault.id);

        // Remove any assignments to this vault from members and groups
        for (const each of [...org.getGroupsForVault(vault), ...org.getMembersForVault(vault)]) {
            each.vaults = each.vaults.filter(v => v.id !== vault.id);
        }

        // Save org
        promises.push(this.storage.save(org));

        await Promise.all(promises);
    }

    async getInvite({ org: orgId, id }: GetInviteParams) {
        const { account } = this._requireAuth();

        const org = await this.storage.get(Org, orgId);
        const invite = org.getInvite(id);

        if (
            !invite ||
            // User may only see invite if they are a vault owner or the invite recipient
            (!org.isOwner(account) && invite.email !== account.email)
        ) {
            throw new Err(ErrorCode.NOT_FOUND);
        }

        return invite;
    }

    async acceptInvite(invite: Invite) {
        // Passed invite object need to have *accepted* status
        if (!invite.accepted) {
            throw new Err(ErrorCode.BAD_REQUEST);
        }

        const { account } = this._requireAuth();

        // Get existing invite object
        const org = await this.storage.get(Org, invite.org.id);
        const existing = org.getInvite(invite.id);

        if (!existing) {
            throw new Err(ErrorCode.NOT_FOUND);
        }

        // Only the invite recipient can accept the invite
        if (existing.email !== account.email) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS, "Only the invite recipient can accept the invite.");
        }

        if (!existing.accepted && invite.invitedBy) {
            // Send message to the creator of the invite notifying them that
            // the recipient has accepted the invite
            this.messenger.send(
                invite.invitedBy.email,
                new InviteAcceptedMessage(invite, `${this.config.clientUrl}/invite/${org.id}/${invite.id}`)
            );
        }

        // Update invite object
        org.invites[org.invites.indexOf(existing)] = invite;

        // Persist changes
        await this.storage.save(org);
    }

    async createAttachment(att: Attachment) {
        const { account } = this._requireAuth();

        const vault = await this.storage.get(Vault, att.vault);
        const org = vault.org && (await this.storage.get(Org, vault.org.id));

        const allowed = org ? org.canWrite(vault, account) : vault.owner === account.id;

        if (!allowed) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        att.id = await uuid();

        const currentUsage = org
            ? (await Promise.all(org.vaults.map(({ id }) => this.attachmentStorage.getUsage(id)))).reduce(
                  (sum: number, each: number) => sum + each,
                  0
              )
            : await this.attachmentStorage.getUsage(vault.id);

        const quota = org ? org.quota : account.quota;

        if (quota.storage !== -1 && currentUsage + att.size > quota.storage * 1e9) {
            throw new Err(ErrorCode.QUOTA_EXCEEDED);
        }

        await this.attachmentStorage.put(att);

        return att;
    }

    async getAttachment({ id, vault: vaultId }: GetAttachmentParams) {
        const { account } = this._requireAuth();

        const vault = await this.storage.get(Vault, vaultId);
        const org = vault.org && (await this.storage.get(Org, vault.org.id));

        const allowed = org ? org.canRead(vault, account) : vault.owner === account.id;

        if (!allowed) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        const att = await this.attachmentStorage.get(vaultId, id);

        return att;
    }

    async deleteAttachment({ vault: vaultId, id }: DeleteAttachmentParams) {
        const { account } = this._requireAuth();

        const vault = await this.storage.get(Vault, vaultId);
        const org = vault.org && (await this.storage.get(Org, vault.org.id));

        const allowed = org ? org.canWrite(vault, account) : vault.owner === account.id;

        if (!allowed) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        await this.attachmentStorage.delete(vaultId, id);
    }

    async updateBilling(params: UpdateBillingParams) {
        if (!this.billingProvider) {
            throw new Err(ErrorCode.NOT_SUPPORTED);
        }
        const { account } = this._requireAuth();

        params.account = params.account || account.id;

        const { account: accId, org: orgId } = params;

        if (orgId) {
            const org = await this.storage.get(Org, orgId);
            if (!org.isOwner(account)) {
                throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
            }
        } else if (accId && accId !== account.id) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        await this.billingProvider.updateBilling(params);
    }

    async getPlans() {
        if (!this.billingProvider) {
            throw new Err(ErrorCode.NOT_SUPPORTED);
        }
        return this.billingProvider.getPlans();
    }

    private _requireAuth(): { account: Account; session: Session } {
        const { account, session } = this.context;

        if (!session || !account) {
            throw new Err(ErrorCode.INVALID_SESSION);
        }

        return { account, session };
    }

    private async _checkEmailVerificationCode(email: string, code: string) {
        let ev: EmailVerification;
        try {
            ev = await this.storage.get(EmailVerification, email);
        } catch (e) {
            if (e.code === ErrorCode.NOT_FOUND) {
                throw new Err(ErrorCode.EMAIL_VERIFICATION_REQUIRED, "Email verification required.");
            } else {
                throw e;
            }
        }

        if (ev.code !== code.toLowerCase()) {
            ev.tries++;
            if (ev.tries > 5) {
                await this.storage.delete(ev);
                throw new Err(ErrorCode.EMAIL_VERIFICATION_TRIES_EXCEEDED, "Maximum number of tries exceeded!");
            } else {
                await this.storage.save(ev);
                throw new Err(ErrorCode.EMAIL_VERIFICATION_FAILED, "Invalid verification code. Please try again!");
            }
        }

        return ev.token;
    }

    private async _checkEmailVerificationToken(email: string, token: string) {
        let ev: EmailVerification;
        try {
            ev = await this.storage.get(EmailVerification, email);
        } catch (e) {
            if (e.code === ErrorCode.NOT_FOUND) {
                throw new Err(ErrorCode.EMAIL_VERIFICATION_FAILED, "Email verification required.");
            } else {
                throw e;
            }
        }

        if (ev.token !== token) {
            throw new Err(ErrorCode.EMAIL_VERIFICATION_FAILED, "Invalid verification token. Please try again!");
        }

        await this.storage.delete(ev);
    }
}

export abstract class BaseServer {
    constructor(public config: ServerConfig, public storage: Storage, public messenger: Messenger) {}

    /** Handles an incoming [[Request]], processing it and constructing a [[Reponse]] */
    async handle(req: Request) {
        const res = new Response();
        try {
            const context: Context = {};
            context.device = req.device && new DeviceInfo().fromRaw(req.device);
            await this._authenticate(req, context);
            await this._process(req, res, context);
            if (context.session) {
                await context.session.authenticate(res);
            }
        } catch (e) {
            this._handleError(e, res);
        }
        return res;
    }

    abstract _process(req: Request, res: Response, ctx: Context): Promise<void>;

    private async _authenticate(req: Request, ctx: Context) {
        if (!req.auth) {
            return;
        }

        let session: Session;

        // Find the session with the id specified in the [[Request.auth]] property
        try {
            session = await this.storage.get(Session, req.auth.session);
        } catch (e) {
            if (e.code === ErrorCode.NOT_FOUND) {
                throw new Err(ErrorCode.INVALID_SESSION);
            } else {
                throw e;
            }
        }

        // Reject expired sessions
        if (session.expires && session.expires < new Date()) {
            throw new Err(ErrorCode.SESSION_EXPIRED);
        }

        // Verify request signature
        if (!(await session.verify(req))) {
            throw new Err(ErrorCode.INVALID_REQUEST);
        }

        // Get account associated with this session
        const account = await this.storage.get(Account, session.account);

        // Store account and session on context
        ctx.session = session;
        ctx.account = account;

        // Update session info
        session.lastUsed = new Date();
        session.device = ctx.device;
        session.updated = new Date();

        const i = account.sessions.findIndex(({ id }) => id === session.id);
        if (i !== -1) {
            account.sessions[i] = session.info;
        } else {
            account.sessions.push(session.info);
        }

        await Promise.all([this.storage.save(session), this.storage.save(account)]);
    }

    private _handleError(e: Error, res: Response) {
        if (e instanceof Err) {
            res.error = {
                code: e.code,
                message: e.message
            };
        } else {
            console.error(e.stack);
            if (this.config.reportErrors) {
                this.messenger.send(this.config.reportErrors, {
                    title: "Padloc Error Notification",
                    text: `The following error occurred at ${new Date().toString()}:\n\n${e.stack}`,
                    html: ""
                });
            }
            res.error = {
                code: ErrorCode.SERVER_ERROR,
                message:
                    "Something went wrong while we were processing your request. " +
                    "Our team has been notified and will resolve the problem as soon as possible!"
            };
        }
    }
}

/**
 * The Padloc server acts as a central repository for [[Account]]s, [[Org]]s
 * and [[Vault]]s. [[Server]] handles authentication, enforces user privileges
 * and acts as a mediator for key exchange between clients.
 *
 * The server component acts on a strict zero-trust, zero-knowledge principle
 * when it comes to sensitive data, meaning no sensitive data is ever exposed
 * to the server at any point, nor should the server (or the person controlling
 * it) ever be able to temper with critical data or trick users into granting
 * them access to encrypted information.
 */
export class Server extends BaseServer {
    constructor(
        /** Server config */
        config: ServerConfig,
        /** Storage for persisting data */
        storage: Storage,
        /** [[Messenger]] implemenation for sending messages to users */
        messenger: Messenger,
        /** Attachment storage */
        public attachmentStorage: AttachmentStorage,
        public billingProvider?: BillingProvider
    ) {
        super(config, storage, messenger);
    }

    async _process(req: Request, res: Response, ctx: Context): Promise<void> {
        const ctlr = new Controller(
            ctx,
            this.config,
            this.storage,
            this.messenger,
            this.attachmentStorage,
            this.billingProvider
        );
        const method = req.method;
        const params = req.params || [];

        switch (method) {
            case "requestEmailVerification":
                await ctlr.requestEmailVerification(new RequestEmailVerificationParams().fromRaw(params[0]));
                break;

            case "completeEmailVerification":
                res.result = await ctlr.completeEmailVerification(
                    new CompleteEmailVerificationParams().fromRaw(params[0])
                );
                break;

            case "initAuth":
                res.result = (await ctlr.initAuth(new InitAuthParams().fromRaw(params[0]))).toRaw();
                break;

            case "updateAuth":
                await ctlr.updateAuth(new Auth().fromRaw(params[0]));
                break;

            case "createSession":
                res.result = (await ctlr.createSession(new CreateSessionParams().fromRaw(params[0]))).toRaw();
                break;

            case "revokeSession":
                if (typeof params[0] !== "string") {
                    throw new Err(ErrorCode.BAD_REQUEST);
                }
                await ctlr.revokeSession(params[0]);
                break;

            case "getAccount":
                res.result = (await ctlr.getAccount()).toRaw();
                break;

            case "createAccount":
                res.result = (await ctlr.createAccount(new CreateAccountParams().fromRaw(params[0]))).toRaw();
                break;

            case "updateAccount":
                res.result = (await ctlr.updateAccount(new Account().fromRaw(params[0]))).toRaw();
                break;

            case "recoverAccount":
                res.result = (await ctlr.recoverAccount(new RecoverAccountParams().fromRaw(params[0]))).toRaw();
                break;

            case "createOrg":
                res.result = (await ctlr.createOrg(new Org().fromRaw(params[0]))).toRaw();
                break;

            case "getOrg":
                if (typeof params[0] !== "string") {
                    throw new Err(ErrorCode.BAD_REQUEST);
                }
                res.result = (await ctlr.getOrg(params[0])).toRaw();
                break;

            case "updateOrg":
                res.result = (await ctlr.updateOrg(new Org().fromRaw(params[0]))).toRaw();
                break;

            case "getVault":
                if (typeof params[0] !== "string") {
                    throw new Err(ErrorCode.BAD_REQUEST);
                }
                res.result = (await ctlr.getVault(params[0])).toRaw();
                break;

            case "updateVault":
                res.result = (await ctlr.updateVault(new Vault().fromRaw(params[0]))).toRaw();
                break;

            case "createVault":
                res.result = (await ctlr.createVault(new Vault().fromRaw(params[0]))).toRaw();
                break;

            case "deleteVault":
                if (typeof params[0] !== "string") {
                    throw new Err(ErrorCode.BAD_REQUEST);
                }
                await ctlr.deleteVault(params[0]);
                break;

            case "getInvite":
                res.result = (await ctlr.getInvite(new GetInviteParams().fromRaw(params[0]))).toRaw();
                break;

            case "acceptInvite":
                await ctlr.acceptInvite(new Invite().fromRaw(params[0]));
                break;

            case "createAttachment":
                res.result = (await ctlr.createAttachment(new Attachment().fromRaw(params[0]))).id;
                break;

            case "getAttachment":
                res.result = (await ctlr.getAttachment(new GetAttachmentParams().fromRaw(params[0]))).toRaw();
                break;

            case "deleteAttachment":
                await ctlr.deleteAttachment(new DeleteAttachmentParams().fromRaw(params[0]));
                break;

            case "updateBilling":
                await ctlr.updateBilling(new UpdateBillingParams().fromRaw(params[0]));
                break;

            case "getPlans":
                const plans = await ctlr.getPlans();
                res.result = plans.map(p => p.toRaw());
                break;

            default:
                throw new Err(ErrorCode.INVALID_REQUEST);
        }
    }
}
