pub mod structs;

#[cfg(test)]
mod tests;

use reqwest::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sessionless::hex::IntoHex;
use sessionless::{Sessionless, Signature};
use std::time::{SystemTime, UNIX_EPOCH};
use std::collections::HashMap;
use crate::structs::{AddieUser, Gateway, Nineum, Spell, SpellResult, SuccessResult, PaymentIntent, Payee, StripeAccountSession, StripeAccountStatus};

pub struct Addie {
    base_url: String,
    client: Client,
    pub sessionless: Sessionless,
}

impl Addie {
    pub fn new(base_url: Option<String>, sessionless: Option<Sessionless>) -> Self {
        Addie {
            base_url: base_url.unwrap_or("https://dev.addie.allyabase.com/".to_string()),
            client: Client::new(),
            sessionless: sessionless.unwrap_or(Sessionless::new()),
        }
    }

    async fn get(&self, url: &str) -> Result<Response, reqwest::Error> {
        self.client.get(url).send().await
    }

    async fn post(&self, url: &str, payload: serde_json::Value) -> Result<Response, reqwest::Error> {
        self.client
            .post(url)
            .json(&payload)
            .send()
            .await
    }

    async fn put(&self, url: &str, payload: serde_json::Value) -> Result<Response, reqwest::Error> {
        self.client
            .put(url)
            .json(&payload)
            .send()
            .await
    }

    async fn delete(&self, url: &str, payload: serde_json::Value) -> Result<Response, reqwest::Error> {
        self.client
            .delete(url)
            .json(&payload)
            .send()
            .await
    }

    fn get_timestamp() -> String {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("Time went backwards")
            .as_millis()
            .to_string()
    }

    pub async fn create_user(&self) -> Result<AddieUser, Box<dyn std::error::Error>> {
        let timestamp = Self::get_timestamp();
        let pub_key = self.sessionless.public_key().to_hex();
        let signature = self.sessionless.sign(&format!("{}{}", timestamp, pub_key)).to_hex();
        
        let payload = json!({
            "timestamp": timestamp,
            "pubKey": pub_key,
            "signature": signature
        }).as_object().unwrap().clone();

        let url = format!("{}user/create", self.base_url);
        let res = self.put(&url, serde_json::Value::Object(payload)).await?;
        let user: AddieUser = res.json().await?;

        Ok(user)
    }

    pub async fn get_user_by_uuid(&self, uuid: &str) -> Result<AddieUser, Box<dyn std::error::Error>> {
        let timestamp = Self::get_timestamp();
        let message = format!("{}{}", timestamp, uuid);
        let signature = self.sessionless.sign(&message).to_hex();

        let url = format!("{}user/{}?timestamp={}&signature={}", self.base_url, uuid, timestamp, signature);
        let res = self.get(&url).await?;
        let user: AddieUser = res.json().await?;

        Ok(user)
    }

    pub async fn add_processor_account(&self, uuid: &str, name: &str, email: &str) -> Result<AddieUser, Box<dyn std::error::Error>> {
        let timestamp = Self::get_timestamp();
        let message = format!("{}{}{}{}", timestamp, uuid, name, email);
        let signature = self.sessionless.sign(&message).to_hex();

        let payload = json!({
            "timestamp": timestamp,
            "name": name,
            "email": email,
            "signature": signature
        }).as_object().unwrap().clone();

        let url = format!("{}user/{}/processor/stripe", self.base_url, uuid);
        let res = self.put(&url, serde_json::Value::Object(payload)).await?;
        let user: AddieUser = res.json().await?;

        Ok(user)
    }

    pub async fn add_processor_express_account(&self, uuid: &str, country: &str, email: &str, refresh_url: &str, return_url: &str) -> Result<AddieUser, Box<dyn std::error::Error>> {
        let timestamp = Self::get_timestamp();
        let message = format!("{}{}{}", timestamp, uuid, email);
        let signature = self.sessionless.sign(&message).to_hex();

        let payload = json!({
            "timestamp": timestamp,
            "country": country,
            "email": email,
            "refreshUrl": refresh_url,
            "returnUrl": return_url,
            "signature": signature
        }).as_object().unwrap().clone();

        let url = format!("{}user/{}/processor/stripe/express", self.base_url, uuid);
        let res = self.put(&url, serde_json::Value::Object(payload)).await?;

        // reqwest doesn't fail on non-2xx by default, and the addie server
        // wraps every internal throw in `res.status(404).send({error: err})`
        // where `err` is a JS Error object that JSON.stringify collapses to
        // `{}` — so parsing that as AddieUser (which requires uuid/pubKey)
        // fails with a useless "could not decode response body". Surface the
        // real status code and body verbatim instead so the actual server
        // failure (missing Stripe env, disabled Express Connect, etc.) is
        // visible in the frontend status toast + Netlify logs together.
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_else(|_| "(no body)".to_string());
            return Err(format!("Addie /processor/stripe/express returned HTTP {status}: {body}").into());
        }
        let user: AddieUser = res.json().await?;
        Ok(user)
    }

    /// Returns an Account Session for the Stripe Connect mobile SDKs'
    /// embedded onboarding, creating the user's Express account first if they
    /// don't have one yet (`country`/`email` are only needed then). Call again
    /// whenever the SDK asks for a fresh client secret.
    pub async fn create_stripe_account_session(&self, uuid: &str, country: Option<&str>, email: Option<&str>) -> Result<StripeAccountSession, Box<dyn std::error::Error>> {
        let timestamp = Self::get_timestamp();
        let signature = self.sessionless.sign(&format!("{}{}", timestamp, uuid)).to_hex();

        let payload = json!({
            "timestamp": timestamp,
            "country": country,
            "email": email,
            "signature": signature
        });

        let url = format!("{}user/{}/processor/stripe/account-session", self.base_url, uuid);
        let res = self.post(&url, payload).await?;
        Self::json_or_error(res, "/processor/stripe/account-session").await
    }

    /// Live status of the user's connected account, straight from Stripe.
    pub async fn get_stripe_account_status(&self, uuid: &str) -> Result<StripeAccountStatus, Box<dyn std::error::Error>> {
        let timestamp = Self::get_timestamp();
        let signature = self.sessionless.sign(&format!("{}{}", timestamp, uuid)).to_hex();

        let url = format!("{}user/{}/processor/stripe/account?timestamp={}&signature={}", self.base_url, uuid, timestamp, signature);
        let res = self.get(&url).await?;
        Self::json_or_error(res, "/processor/stripe/account").await
    }

    /// Addie reports failures as `{error: "..."}`, usually with a non-2xx
    /// status — but not always: the timestamp-freshness middleware answers
    /// HTTP 200 with an error body. So treat an `error` field as a failure
    /// whatever the status, rather than letting a struct whose fields all
    /// have defaults decode it into a plausible-looking empty answer.
    async fn json_or_error<T: serde::de::DeserializeOwned>(res: Response, route: &str) -> Result<T, Box<dyn std::error::Error>> {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();

        let parsed: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("Addie {route} returned HTTP {status} with unreadable body ({e}): {body}"))?;

        if let Some(message) = parsed.get("error").and_then(|e| e.as_str()) {
            return Err(format!("Addie {route}: {message}").into());
        }
        if !status.is_success() {
            return Err(format!("Addie {route} returned HTTP {status}: {body}").into());
        }

        Ok(serde_json::from_value(parsed)?)
    }

    pub async fn get_payment_intent(&self, uuid: &str, processor: &str, amount: &u32, currency: &str, payees: &Vec<Payee>) -> Result<PaymentIntent, Box<dyn std::error::Error>> {
        let timestamp = Self::get_timestamp();
        let message = format!("{}{}{}{}", timestamp, uuid, amount, currency);
        let signature = self.sessionless.sign(&message).to_hex();

        let payload = json!({
            "timestamp": timestamp,
            "amount": amount,
            "currency": currency,
            "payees": payees,
            "signature": signature
        }).as_object().unwrap().clone();

        let url = format!("{}user/{}/processor/{}/intent", self.base_url, uuid, processor);
        let res = self.post(&url, serde_json::Value::Object(payload)).await?;
        let intent: PaymentIntent = res.json().await?;

        Ok(intent)
    }

    pub async fn get_payment_intent_without_splits(&self, uuid: &str, processor: &str, amount: &u32, currency: &str) -> Result<PaymentIntent, Box<dyn std::error::Error>> {
        let timestamp = Self::get_timestamp();
        let message = format!("{}{}{}{}", timestamp, uuid, amount, currency);
        let signature = self.sessionless.sign(&message).to_hex();

        let payload = json!({
            "timestamp": timestamp,
            "amount": amount,
            "currency": currency,
            "signature": signature
        }).as_object().unwrap().clone();

        let url = format!("{}user/{}/processor/{}/intent-without-splits", self.base_url, uuid, processor);
        let res = self.post(&url, serde_json::Value::Object(payload)).await?;
        let intent: PaymentIntent = res.json().await?;

        Ok(intent)
    }

    pub async fn delete_user(&self, uuid: &str) -> Result<SuccessResult, Box<dyn std::error::Error>> {
        let timestamp = Self::get_timestamp();
        let message = format!("{}{}", timestamp, uuid);
        let signature = self.sessionless.sign(&message).to_hex();

        let payload = json!({
          "timestamp": timestamp,
          "uuid": uuid,
          "signature": signature
        }).as_object().unwrap().clone();

        let url = format!("{}user/{}", self.base_url, uuid);
        let res = self.delete(&url, serde_json::Value::Object(payload)).await?;
        let success: SuccessResult = res.json().await?;

        Ok(success)
    }
}
