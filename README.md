# Addie

*Addie* (named for an [early 20th century Australian accountant][addie], whose name also happens to contain a mathematical operation) handles the accounting for Planet Nine.
Any transaction which involves human money should probably route through Addie.

## Overview

The Addie server links the private and pseudonymous Planet Nine ecosystem with the real world identification associated with traditional banking (like using a credit card). 
Since this requires additional configuration, and api keys, and whatnot, this service won't be deployed using [Hedy][hedy]. 
It is still open source, and people are free to host it themselves with their own keys. 
I wish payment credentials were shareable so as to make that not a UX nightmare, but alas, they are not, so we'll see how this goes.

Addie is not a [resolver][resolver], and really contains very little logic at all. 
It exists simply as a repository for tokenized payment methods to be used with processors like Stripe and Square.
Because these tokens are kind of PII, Addie handles its own auth rather than using [Continue Bee][continuebee].

## API

So you create a user, and then store payment tokens, and use them for purchases.

<details>
 <summary><code>PUT</code> <code><b>/user/create</b></code> <code>Creates a new user if pubKey does not exist, and returns existing uuid if it does.</code></summary>

##### Parameters

> | name         |  required     | data type               | description                                                           |
> |--------------|-----------|-------------------------|-----------------------------------------------------------------------|
> | pubKey       |  true     | string (hex)            | the publicKey of the user's keypair  |
> | timestamp    |  true     | string                  | in a production system timestamps narrow window for replay attacks  |
> | signature    |  true     | string (signature)      | the signature from sessionless for the message  |


##### Responses

> | http code     | content-type                      | response                                                            |
> |---------------|-----------------------------------|---------------------------------------------------------------------|
> | `200`         | `application/json`                | `USER`   |
> | `400`         | `application/json`                | `{"code":"400","message":"Bad Request"}`                            |

##### Example cURL

> ```javascript
>  curl -X PUT -H "Content-Type: application/json" -d '{"pubKey": "key", "timestamp": "now", "signature": "sig"}' https://<placeholderURL>/user/create
> ```

</details>

<details>
 <summary><code>PUT</code> <code><b>/user/:uuid/processor/:processor</b></code> <code>Creates an account token for a processor</code></summary>

##### Parameters

> | name         |  required     | data type               | description                                                           |
> |--------------|-----------|-------------------------|-----------------------------------------------------------------------|
> | name         |  true     | string                  | the user's name  |
> | email        |  true     | string                  | the user's email  |
> | timestamp    |  true     | string                  | in a production system timestamps narrow window for replay attacks  |
> | signature    |  true     | string (signature)      | the signature from sessionless for the message  |


##### Responses

> | http code     | content-type                      | response                                                            |
> |---------------|-----------------------------------|---------------------------------------------------------------------|
> | `200`         | `application/json`                | `USER`   |
> | `400`         | `application/json`                | `{"code":"400","message":"Bad Request"}`                            |

##### Example cURL

> ```javascript
>  curl -X PUT -H "Content-Type: application/json" -d '{"name": "name", "email": "email@email.com", "timestamp": "now", "signature": "sig"}' https://<placeholderURL>/user/<uuid>/processor/<processor>
> ```

</details>

<details>
  <summary><code>POST</code> <code><b>/user/:uuid/payment-token</b></code> <code>Stores a payment token</code></summary>

##### Parameters

> | name         |  required     | data type               | description                                                           |
> |--------------|-----------|-------------------------|-----------------------------------------------------------------------|
> | timestamp    |  true     | object                  | timestamp of request  |
> | paymentToken |  true     | object                  | paymentToken of request  |


##### Responses

> | http code     | content-type                      | response                                                            |
> |---------------|-----------------------------------|---------------------------------------------------------------------|
> | `200`         | `application/json`                | `{success: <bool>, signatureMap: TBD}`   |
> | `400`         | `application/json`                | `{"code":"400","message":"Bad Request"}`                            |

##### Example cURL

> ```javascript
>  curl -X POST -H "Content-Type: application/json" -d '[SPELL]' https://<placeholderURL>/user/<uuid>/associate
> ```

</details>

<details>
  <summary><code>POST</code> <code><b>/user/:uuid/payment</b></code> <code>Makes a payment</code></summary>

##### Parameters

> | name         |  required     | data type               | description                                                           |
> |--------------|-----------|-------------------------|-----------------------------------------------------------------------|
> | timestamp    |  true     | object                  | timestamp of request  |
> | amount       |  true     | object                  | amount of the payment  |
> | processor    |  true     | object                  | payment processor to use  |
> | paymentToken |  true     | object                  | paymentToken of request  |


##### Responses

> | http code     | content-type                      | response                                                            |
> |---------------|-----------------------------------|---------------------------------------------------------------------|
> | `200`         | `application/json`                | `{success: <bool>, signatureMap: TBD}`   |
> | `400`         | `application/json`                | `{"code":"400","message":"Bad Request"}`                            |

##### Example cURL

> ```javascript
>  curl -X POST -H "Content-Type: application/json" -d '[SPELL]' https://<placeholderURL>/user/<uuid>/associate
> ```

</details>

<details>
 <summary><code>POST</code> <code><b>/user/:uuid/processor/:processor</b></code> <code>Gets a client token for a payment from the given processor</code></summary>

##### Types

Payee: {
  pubKey: <public key>,
  amount: Int
};

PaymentTokenResponse: {
  paymentToken: String,
  paymentExtra: String,
  customerId: String,
  paymentKey: String
};

##### Parameters

> | name         |  required     | data type               | description                                                           |
> |--------------|-----------|-------------------------|-----------------------------------------------------------------------|
> | processor    |  true     | String                  | the processor for the token like stripe  |     
> | amount       |  true     | Int                     | the amount of the transaction  |               
> | currency     |  true     | String                  | the currency for the transaction  |               
> | payees       |  false    | Payee[]                 | the Payees for the transaction if any
> | timestamp    |  true     | string                  | in a production system timestamps prevent replay attacks  |
> | signature    |  true     | string (signature)      | the signature from sessionless for the message  |               

##### Responses

> | http code     | content-type                      | response                                                            |
> |---------------|-----------------------------------|---------------------------------------------------------------------|
> | `200`         | `application/json`                | PaymentTokenResponse   |
> | `406`         | `application/json`                | `{"code":"406","message":"Not acceptable"}`                            |

##### Example cURL

> ```javascript
>  curl -X GET -H "Content-Type: application/json" https://<placeholderURL>/<uuid>?timestamp=123&signature=signature
> ```

</details>

<details>
 <summary><code>GET</code> <code><b>/user/:uuid?timestamp=<timestamp>&signature=<signature>&pause=<bool></b></code> <code>Pauses or unpauses all payments through Addie</code></summary>

##### Parameters

> | name         |  required     | data type               | description                                                           |
> |--------------|-----------|-------------------------|-----------------------------------------------------------------------|
> | timestamp    |  true     | string                  | in a production system timestamps prevent replay attacks  |
> | signature    |  true     | string (signature)      | the signature from sessionless for the message  |                  
> | pause        |  true     | bool                    | the signature from sessionless for the message  |                  

##### Responses

> | http code     | content-type                      | response                                                            |
> |---------------|-----------------------------------|---------------------------------------------------------------------|
> | `200`         | `application/json`                | `USER`   |
> | `406`         | `application/json`                | `{"code":"406","message":"Not acceptable"}`                            |

##### Example cURL

> ```javascript
>  curl -X GET -H "Content-Type: application/json" https://<placeholderURL>/<uuid>?timestamp=123&signature=signature
> ```

</details>

<details> 
  <summary><code>DELETE</code> <code><b>/user/delete</b></code> <code>Deletes a uuid and pubKey.
signature message is: timestamp + userUUID</code></summary>

##### Parameters

> | name         |  required     | data type               | description                                                           |
> |--------------|-----------|-------------------------|-----------------------------------------------------------------------|
> | timestamp    |  true     | string                  | in a production system timestamps prevent replay attacks  |
> | userUUID     |  true     | string                  | the user's uuid
> | signature    |  true     | string (signature)      | the signature from sessionless for the message  |

##### Responses

> | http code     | content-type                      | response                                                            |
> |---------------|-----------------------------------|---------------------------------------------------------------------|
> | `202`         | `application/json`                | empty   |
> | `400`         | `application/json`                | `{"code":"400","message":"Bad Request"}`                            |

##### Example cURL

> ```javascript
>  curl -X DELETE https://pref.planetnine.app/user/delete
> ```

</details>

## Client SDKs

Client SDKs need to generate keys via Sessionless, and implement the networking to interface with the server.
To do so they should implement the following methods:  

`createUser(saveKeys, getKeys)` - Should generate keys, save them appropriately client side, and PUT to /user/create. 

`addProcessorAccount(uuid, processorPayload)` - Should POST the passed in processor payload to user/:uuid/processor/:processor.
    
`getPaymentIntent(uuid, processor, processorPayload)` - For PCI compliance, clients can't just enter payment details and send them to a server. This gets the client-side info needed to display an intent for a processor. POST to user/:uuid/processor/:processor/intent.

`deleteUser(uuid)` - DELETEs the user at user/:uuid

`deleteUser(uuid, hash)` - Should DELETE a user by calling /user/:uuid.

[addie]: https://www.researchgate.net/publication/44843070_Mary_Addison_Hamilton_Australia's_first_lady_of_numbers
[hedy]: https://github.com/planet-nine-app/hedy
[resolver]: https://github.com/planet-nine-app/MAGIC/blob/main/README-DEV.md#resolvers
[continuebee]: https://github.com/planet-nine-app/continuebee

