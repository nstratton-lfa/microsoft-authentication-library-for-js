/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { AuthenticationResult, CommonAuthorizationCodeRequest, AuthorizationCodeClient, ThrottlingUtils, CommonEndSessionRequest, UrlString, AuthError, OIDC_DEFAULT_SCOPES, Constants, ProtocolUtils, ServerAuthorizationCodeResponse, PerformanceEvents } from "@azure/msal-common";
import { StandardInteractionClient } from "./StandardInteractionClient";
import { PopupWindowAttributes, PopupUtils } from "../utils/PopupUtils";
import { EventType } from "../event/EventType";
import { InteractionType, ApiId } from "../utils/BrowserConstants";
import { PopupHandler, PopupParams } from "../interaction_handler/PopupHandler";
import { EndSessionPopupRequest } from "../request/EndSessionPopupRequest";
import { NavigationOptions } from "../navigation/NavigationOptions";
import { BrowserUtils } from "../utils/BrowserUtils";
import { PopupRequest } from "../request/PopupRequest";
import { NativeInteractionClient } from "./NativeInteractionClient";
import { NativeMessageHandler } from "../broker/nativeBroker/NativeMessageHandler";
import { BrowserAuthError } from "../error/BrowserAuthError";

export class PopupClient extends StandardInteractionClient {
    /**
     * Acquires tokens by opening a popup window to the /authorize endpoint of the authority
     * @param request
     */
    acquireToken(request: PopupRequest): Promise<AuthenticationResult> {
        try {
            const popupName = PopupUtils.generatePopupName(this.config.auth.clientId, request.scopes || OIDC_DEFAULT_SCOPES, request.authority || this.config.auth.authority, this.correlationId);
            const popupWindowAttributes = request.popupWindowAttributes || {};

            // asyncPopups flag is true. Acquires token without first opening popup. Popup will be opened later asynchronously.
            if (this.config.system.asyncPopups) {
                this.logger.verbose("asyncPopups set to true, acquiring token");
                // Passes on popup position and dimensions if in request
                return this.acquireTokenPopupAsync(request, popupName, popupWindowAttributes);
            } else {
                // asyncPopups flag is set to false. Opens popup before acquiring token.
                this.logger.verbose("asyncPopup set to false, opening popup before acquiring token");
                const popup = PopupUtils.openSizedPopup("about:blank", popupName, popupWindowAttributes, this.logger);
                return this.acquireTokenPopupAsync(request, popupName, popupWindowAttributes, popup);
            }
        } catch (e) {
            return Promise.reject(e);
        }
    }

    /**
     * Clears local cache for the current user then opens a popup window prompting the user to sign-out of the server
     * @param logoutRequest
     */
    logout(logoutRequest?: EndSessionPopupRequest): Promise<void> {
        try {
            this.logger.verbose("logoutPopup called");
            const validLogoutRequest = this.initializeLogoutRequest(logoutRequest);

            const popupName = PopupUtils.generateLogoutPopupName(this.config.auth.clientId, validLogoutRequest);
            const authority = logoutRequest && logoutRequest.authority;
            const mainWindowRedirectUri = logoutRequest && logoutRequest.mainWindowRedirectUri;
            const popupWindowAttributes = logoutRequest?.popupWindowAttributes || {};

            // asyncPopups flag is true. Acquires token without first opening popup. Popup will be opened later asynchronously.
            if (this.config.system.asyncPopups) {
                this.logger.verbose("asyncPopups set to true");
                // Passes on popup position and dimensions if in request
                return this.logoutPopupAsync(validLogoutRequest, popupName, popupWindowAttributes, authority, undefined, mainWindowRedirectUri);
            } else {
                // asyncPopups flag is set to false. Opens popup before logging out.
                this.logger.verbose("asyncPopup set to false, opening popup");
                const popup = PopupUtils.openSizedPopup("about:blank", popupName, popupWindowAttributes, this.logger);
                return this.logoutPopupAsync(validLogoutRequest, popupName, popupWindowAttributes, authority, popup, mainWindowRedirectUri);
            }
        } catch (e) {
            // Since this function is synchronous we need to reject
            return Promise.reject(e);
        }
    }

    /**
     * Helper which obtains an access_token for your API via opening a popup window in the user's browser
     * @param validRequest
     * @param popupName
     * @param popup
     * @param popupWindowAttributes
     *
     * @returns A promise that is fulfilled when this function has completed, or rejected if an error was raised.
     */
    protected async acquireTokenPopupAsync(request: PopupRequest, popupName: string, popupWindowAttributes: PopupWindowAttributes, popup?: Window|null): Promise<AuthenticationResult> {
        this.logger.verbose("acquireTokenPopupAsync called");
        const serverTelemetryManager = this.initializeServerTelemetryManager(ApiId.acquireTokenPopup);
        const validRequest = await this.initializeAuthorizationRequest(request, InteractionType.Popup);
        this.browserStorage.updateCacheEntries(validRequest.state, validRequest.nonce, validRequest.authority, validRequest.loginHint || Constants.EMPTY_STRING, validRequest.account || null);

        try {
            // Create auth code request and generate PKCE params
            const authCodeRequest: CommonAuthorizationCodeRequest = await this.initializeAuthorizationCodeRequest(validRequest);

            // Initialize the client
            const authClient: AuthorizationCodeClient = await this.createAuthCodeClient(serverTelemetryManager, validRequest.authority, validRequest.azureCloudOptions);
            this.logger.verbose("Auth code client created");

            const isNativeBroker = NativeMessageHandler.isNativeAvailable(this.config, this.logger, this.nativeMessageHandler, request.authenticationScheme);
            // Start measurement for server calls with native brokering enabled
            let fetchNativeAccountIdMeasurement;
            if (isNativeBroker) {
                fetchNativeAccountIdMeasurement = this.performanceClient.startMeasurement(PerformanceEvents.FetchAccountIdWithNativeBroker, request.correlationId);
            }

            // Create acquire token url.
            const navigateUrl = await authClient.getAuthCodeUrl({
                ...validRequest,
                nativeBroker: isNativeBroker
            });

            // Create popup interaction handler.
            const interactionHandler = new PopupHandler(authClient, this.browserStorage, authCodeRequest, this.logger);

            // Show the UI once the url has been created. Get the window handle for the popup.
            const popupParameters: PopupParams = {
                popup,
                popupName,
                popupWindowAttributes
            };
            const popupWindow: Window = interactionHandler.initiateAuthRequest(navigateUrl, popupParameters);
            this.eventHandler.emitEvent(EventType.POPUP_OPENED, InteractionType.Popup, {popupWindow}, null);

            // Monitor the window for the hash. Return the string value and close the popup when the hash is received. Default timeout is 60 seconds.
            const hash = await interactionHandler.monitorPopupForHash(popupWindow);
            // Deserialize hash fragment response parameters.
            const serverParams: ServerAuthorizationCodeResponse = UrlString.getDeserializedHash(hash);
            const state = this.validateAndExtractStateFromHash(serverParams, InteractionType.Popup, validRequest.correlationId);
            // Remove throttle if it exists
            ThrottlingUtils.removeThrottle(this.browserStorage, this.config.auth.clientId, authCodeRequest);

            if (serverParams.accountId) {
                this.logger.verbose("Account id found in hash, calling WAM for token");
                // end measurement for server call with native brokering enabled
                if (fetchNativeAccountIdMeasurement) {
                    fetchNativeAccountIdMeasurement.endMeasurement({
                        success: true,
                        isNativeBroker: true
                    });
                }

                if (!this.nativeMessageHandler) {
                    throw BrowserAuthError.createNativeConnectionNotEstablishedError();
                }
                const nativeInteractionClient = new NativeInteractionClient(this.config, this.browserStorage, this.browserCrypto, this.logger, this.eventHandler, this.navigationClient, ApiId.acquireTokenPopup, this.performanceClient, this.nativeMessageHandler, serverParams.accountId, validRequest.correlationId);
                const { userRequestState } = ProtocolUtils.parseRequestState(this.browserCrypto, state);
                return nativeInteractionClient.acquireToken({
                    ...validRequest,
                    state: userRequestState,
                    prompt: undefined // Server should handle the prompt, ideally native broker can do this part silently
                }).finally(() => {
                    this.browserStorage.cleanRequestByState(state);
                });
            }

            // Handle response from hash string.
            const result = await interactionHandler.handleCodeResponseFromHash(hash, state, authClient.authority, this.networkClient);

            return result;
        } catch (e) {
            if (popup) {
                // Close the synchronous popup if an error is thrown before the window unload event is registered
                popup.close();
            }

            if (e instanceof AuthError) {
                (e as AuthError).setCorrelationId(this.correlationId);
            }

            serverTelemetryManager.cacheFailedRequest(e);
            this.browserStorage.cleanRequestByState(validRequest.state);
            throw e;
        }
    }

    /**
     *
     * @param validRequest
     * @param popupName
     * @param requestAuthority
     * @param popup
     * @param mainWindowRedirectUri
     * @param popupWindowAttributes
     */
    protected async logoutPopupAsync(validRequest: CommonEndSessionRequest, popupName: string, popupWindowAttributes: PopupWindowAttributes, requestAuthority?: string, popup?: Window|null, mainWindowRedirectUri?: string): Promise<void> {
        this.logger.verbose("logoutPopupAsync called");
        this.eventHandler.emitEvent(EventType.LOGOUT_START, InteractionType.Popup, validRequest);

        const serverTelemetryManager = this.initializeServerTelemetryManager(ApiId.logoutPopup);

        try {
            // Clear cache on logout
            await this.clearCacheOnLogout(validRequest.account);

            // Initialize the client
            const authClient = await this.createAuthCodeClient(serverTelemetryManager, requestAuthority);
            this.logger.verbose("Auth code client created");

            // Create logout string and navigate user window to logout.
            const logoutUri: string = authClient.getLogoutUri(validRequest);

            this.eventHandler.emitEvent(EventType.LOGOUT_SUCCESS, InteractionType.Popup, validRequest);

            const popupUtils = new PopupUtils(this.browserStorage, this.logger);
            // Open the popup window to requestUrl.
            const popupWindow = popupUtils.openPopup(logoutUri, {popupName, popupWindowAttributes, popup});
            this.eventHandler.emitEvent(EventType.POPUP_OPENED, InteractionType.Popup, {popupWindow}, null);

            try {
                // Don't care if this throws an error (User Cancelled)
                await popupUtils.monitorPopupForSameOrigin(popupWindow);
                this.logger.verbose("Popup successfully redirected to postLogoutRedirectUri");
            } catch (e) {
                this.logger.verbose(`Error occurred while monitoring popup for same origin. Session on server may remain active. Error: ${e}`);
            }

            popupUtils.cleanPopup(popupWindow);

            if (mainWindowRedirectUri) {
                const navigationOptions: NavigationOptions = {
                    apiId: ApiId.logoutPopup,
                    timeout: this.config.system.redirectNavigationTimeout,
                    noHistory: false
                };
                const absoluteUrl = UrlString.getAbsoluteUrl(mainWindowRedirectUri, BrowserUtils.getCurrentUri());

                this.logger.verbose("Redirecting main window to url specified in the request");
                this.logger.verbosePii(`Redirecting main window to: ${absoluteUrl}`);
                this.navigationClient.navigateInternal(absoluteUrl, navigationOptions);
            } else {
                this.logger.verbose("No main window navigation requested");
            }
        } catch (e) {
            if (popup) {
                // Close the synchronous popup if an error is thrown before the window unload event is registered
                popup.close();
            }

            if (e instanceof AuthError) {
                (e as AuthError).setCorrelationId(this.correlationId);
            }

            this.browserStorage.setInteractionInProgress(false);
            this.eventHandler.emitEvent(EventType.LOGOUT_FAILURE, InteractionType.Popup, null, e);
            this.eventHandler.emitEvent(EventType.LOGOUT_END, InteractionType.Popup);
            serverTelemetryManager.cacheFailedRequest(e);
            throw e;
        }

        this.eventHandler.emitEvent(EventType.LOGOUT_END, InteractionType.Popup);
    }
}
