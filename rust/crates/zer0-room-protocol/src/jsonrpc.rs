//! Strict JSON-RPC 2.0 envelopes for room transport frames.

use serde::de::{self, Deserializer};
use serde::ser::{Error as _, SerializeStruct, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};

use crate::RoomEvent;

/// The only JSON-RPC version accepted on the room transport.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct JsonRpcVersion;

impl Serialize for JsonRpcVersion {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str("2.0")
    }
}

impl<'de> Deserialize<'de> for JsonRpcVersion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match String::deserialize(deserializer)?.as_str() {
            "2.0" => Ok(Self),
            version => Err(de::Error::custom(format!(
                "unsupported JSON-RPC version: {version}"
            ))),
        }
    }
}

/// A request identifier that never coerces numeric JSON values through `f64`.
#[derive(Clone, Debug, PartialEq)]
pub enum JsonRpcId {
    String(String),
    Number(Number),
}

impl Serialize for JsonRpcId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::String(value) => serializer.serialize_str(value),
            Self::Number(value) if is_safe_number(value) => value.serialize(serializer),
            Self::Number(_) => Err(S::Error::custom(
                "JSON-RPC numeric id must be a signed JS-safe integer",
            )),
        }
    }
}

impl<'de> Deserialize<'de> for JsonRpcId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        match value {
            Value::String(value) => Ok(Self::String(value)),
            Value::Number(value) if is_safe_number(&value) => Ok(Self::Number(value)),
            _ => Err(de::Error::custom(
                "JSON-RPC numeric id must be a signed JS-safe integer",
            )),
        }
    }
}

fn is_safe_number(value: &Number) -> bool {
    value
        .as_i64()
        .is_some_and(|number| number.unsigned_abs() <= 9_007_199_254_740_991)
        || value
            .as_u64()
            .is_some_and(|number| number <= 9_007_199_254_740_991)
}

/// A response identifier. JSON-RPC permits explicit `null`, but never a missing id.
#[derive(Clone, Debug, PartialEq)]
pub enum JsonRpcResponseId {
    Id(JsonRpcId),
    Null,
}

impl Serialize for JsonRpcResponseId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Id(id) => id.serialize(serializer),
            Self::Null => serializer.serialize_unit(),
        }
    }
}

impl<'de> Deserialize<'de> for JsonRpcResponseId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        if value.is_null() {
            return Ok(Self::Null);
        }
        serde_json::from_value(value)
            .map(Self::Id)
            .map_err(de::Error::custom)
    }
}

/// A JSON-RPC request envelope sent to the room host.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JsonRpcRequest {
    pub jsonrpc: JsonRpcVersion,
    pub id: JsonRpcId,
    pub method: String,
    #[serde(
        deserialize_with = "deserialize_object_value",
        serialize_with = "serialize_object_value"
    )]
    pub params: Value,
}

fn deserialize_object_value<'de, D>(deserializer: D) -> Result<Value, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(de::Error::custom(
            "JSON-RPC request params must be an object",
        ))
    }
}

fn serialize_object_value<S>(value: &Value, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    if value.is_object() {
        value.serialize(serializer)
    } else {
        Err(S::Error::custom(
            "JSON-RPC request params must be an object",
        ))
    }
}

/// A structured error returned by the room host.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// A successful JSON-RPC response. `result` is required and may be JSON `null`.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct JsonRpcSuccessResponse {
    jsonrpc: JsonRpcVersion,
    id: JsonRpcResponseId,
    result: Value,
}

/// A failed JSON-RPC response.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct JsonRpcErrorResponse {
    jsonrpc: JsonRpcVersion,
    id: JsonRpcResponseId,
    error: JsonRpcError,
}

/// A room-host response with exactly one of `result` or `error`.
#[derive(Clone, Debug, PartialEq)]
pub enum JsonRpcResponse {
    Success {
        jsonrpc: JsonRpcVersion,
        id: JsonRpcResponseId,
        result: Value,
    },
    Error {
        jsonrpc: JsonRpcVersion,
        id: JsonRpcResponseId,
        error: JsonRpcError,
    },
}

impl Serialize for JsonRpcResponse {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Success {
                jsonrpc,
                id,
                result,
            } => {
                let mut response = serializer.serialize_struct("JsonRpcResponse", 3)?;
                response.serialize_field("jsonrpc", jsonrpc)?;
                response.serialize_field("id", id)?;
                response.serialize_field("result", result)?;
                response.end()
            }
            Self::Error { jsonrpc, id, error } => {
                let mut response = serializer.serialize_struct("JsonRpcResponse", 3)?;
                response.serialize_field("jsonrpc", jsonrpc)?;
                response.serialize_field("id", id)?;
                response.serialize_field("error", error)?;
                response.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for JsonRpcResponse {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum RawResponse {
            Success(JsonRpcSuccessResponse),
            Error(JsonRpcErrorResponse),
        }

        let value = Value::deserialize(deserializer)?;
        match serde_json::from_value(value).map_err(de::Error::custom)? {
            RawResponse::Success(response) => Ok(Self::Success {
                jsonrpc: response.jsonrpc,
                id: response.id,
                result: response.result,
            }),
            RawResponse::Error(response) => Ok(Self::Error {
                jsonrpc: response.jsonrpc,
                id: response.id,
                error: response.error,
            }),
        }
    }
}

/// The only notification method the room transport accepts.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RoomEventNotificationMethod;

impl Serialize for RoomEventNotificationMethod {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str("zer0/room/event")
    }
}

impl<'de> Deserialize<'de> for RoomEventNotificationMethod {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match String::deserialize(deserializer)?.as_str() {
            "zer0/room/event" => Ok(Self),
            method => Err(de::Error::custom(format!(
                "unsupported room notification method: {method}"
            ))),
        }
    }
}

/// A validated room event notification from the host.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RoomEventNotification {
    pub jsonrpc: JsonRpcVersion,
    pub method: RoomEventNotificationMethod,
    #[serde(deserialize_with = "deserialize_room_event")]
    pub params: RoomEvent,
}

impl RoomEventNotification {
    pub fn new(params: RoomEvent) -> Self {
        Self {
            jsonrpc: JsonRpcVersion,
            method: RoomEventNotificationMethod,
            params,
        }
    }
}

fn deserialize_room_event<'de, D>(deserializer: D) -> Result<RoomEvent, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    RoomEvent::from_value(value).map_err(de::Error::custom)
}

/// A complete frame accepted from the room host.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ServerFrame {
    Event(RoomEventNotification),
    Response(JsonRpcResponse),
}

impl<'de> Deserialize<'de> for ServerFrame {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        let object = value
            .as_object()
            .ok_or_else(|| de::Error::custom("room server frame must be a JSON object"))?;

        if object.contains_key("method") {
            serde_json::from_value::<RoomEventNotification>(value)
                .map(Self::Event)
                .map_err(de::Error::custom)
        } else {
            serde_json::from_value::<JsonRpcResponse>(value)
                .map(Self::Response)
                .map_err(de::Error::custom)
        }
    }
}

/// Decode one complete strict room-host JSON-RPC frame.
pub fn decode_server_frame(bytes: &[u8]) -> Result<ServerFrame, serde_json::Error> {
    serde_json::from_slice(bytes)
}
