import can
import json
import paho.mqtt.client as mqtt
import time
import sys
import os
import ssl
import traceback
import re
import signal
import threading

MAX_RETRIES = 100
MAX_SEND_FAILURES = 10
shutdown_requested = False
send_failure_count = 0
send_failure_lock = threading.Lock()

def handle_signal(signum, frame):
    global shutdown_requested
    print(f"Received signal {signum}, shutting down...")
    shutdown_requested = True

# Load .env file from script directory
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(SCRIPT_DIR, '.env')
if os.path.isfile(ENV_FILE):
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip().strip('\r')
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                key = key.strip()
                value = value.strip()
                os.environ[key] = value
    print(f"Loaded env from {ENV_FILE}")
else:
    print(f"Warning: No .env file found at {ENV_FILE}")

# MQTT settings
# Require these to be set via environment variables
MQTT_BROKER_URL = os.environ.get('MQTT_BROKER_URL')
if not MQTT_BROKER_URL:
    print('ERROR: MQTT_BROKER_URL environment variable must be set', file=sys.stderr)
    sys.exit(1)

match = re.match(r'(mqtts?)://([^:]+):(\d+)', MQTT_BROKER_URL)
if not match:
    print(f'ERROR: Invalid MQTT_BROKER_URL format: {MQTT_BROKER_URL}', file=sys.stderr)
    sys.exit(1)

protocol = match.group(1)  # 'mqtt' or 'mqtts'
MQTT_BROKER = match.group(2)  # hostname
MQTT_PORT = int(match.group(3))  # port
USE_TLS = (protocol == 'mqtts')

MQTT_INBOUND_TOPIC = 'can/inbound'
MQTT_OUTBOUND_TOPIC = 'can/outbound'
MQTT_CA_CERT_PATH = os.path.join(SCRIPT_DIR, 'ca.pem')

MQTT_USERNAME = os.environ.get('MQTT_USERNAME')
if not MQTT_USERNAME:
    print('ERROR: MQTT_USERNAME environment variable must be set', file=sys.stderr)
    sys.exit(1)

MQTT_PASSWORD = os.environ.get('MQTT_PASSWORD')
if not MQTT_PASSWORD:
    print('ERROR: MQTT_PASSWORD environment variable must be set', file=sys.stderr)
    sys.exit(1)

def on_subscribe(client, userdata, mid, reason_code_list, properties):
    print(f"Subscribed with message ID: {mid}")

def on_message(client, userdata, msg):
    global send_failure_count
    bus = userdata
    try:
        # Conver the MQTT data into JSON
        m_decode = msg.payload.decode('utf-8')
        received_data = json.loads(m_decode)
        # Check to ensure we have what is needed before attempting to send
        if (received_data):
            current_timestamp = time.time()
            if ('identifier' in received_data) and \
            ('data_length_code' in received_data) and \
            ('data' in received_data) and \
            ('extd' in received_data) and \
            ('rtr' in received_data) and \
            ('ss' in received_data) and \
            ('self' in received_data):
                # Create a datetime object for the timestamp
                msgObject = can.Message()
                msgObject.timestamp = current_timestamp
                msgObject.arbitration_id = int(received_data['identifier'],16)
                msgObject.is_extended_id = (received_data['extd'] == 1)
                msgObject.is_remote_frame = (received_data['rtr'] == 1)
                msgObject.is_error_frame = False
                msgObject.channel = None
                msgObject.dlc = received_data['data_length_code']
                # Convert bit arrays to bytes
                # Each inner array represents 8 bits that form one byte
                data_bytes = []
                for bit_array in received_data['data']:
                    # Convert array of bits to a byte value
                    # bit_array[0] is MSB (bit 7), bit_array[7] is LSB (bit 0)
                    byte_value = 0
                    for i, bit in enumerate(bit_array):
                        byte_value |= (bit << (7 - i))
                    data_bytes.append(byte_value)
                # Use data_length_code to determine how many bytes to send (0-8)
                dlc = received_data['data_length_code']
                dlc = min(dlc, 8)  # Ensure DLC doesn't exceed 8 for standard CAN
                # Extract only the number of bytes specified by DLC
                actual_data = data_bytes[:dlc]
                msgObject.data = actual_data
                msgObject.is_fd = False # Will need to be dynamic in the future
                msgObject.is_rx = False # Fixed value since this is in the send method
                msgObject.bitrate_switch = False # Will need to be dynamic in the future
                msgObject.error_state_indicator = False # Will need to be dyamic in the future
                try:
                    bus.send(msgObject)
                    with send_failure_lock:
                        send_failure_count = 0
                except Exception as e:
                    with send_failure_lock:
                        send_failure_count += 1
                    print(f"CAN send failed ({send_failure_count}): {e}")
    except Exception as e:
        print(f"Error: {e}")

def on_connect(client, userdata, flags, reason_code, properties):
    if reason_code == 0:
        print("Connected to MQTT broker")
        client.subscribe(MQTT_OUTBOUND_TOPIC)
    else:
        print(f"Failed to connect to MQTT broker: {reason_code}")

def on_disconnect(client, userdata, flags, reason_code, properties):
    if reason_code == 0:
        print("Disconnected from MQTT broker (clean)")
    else:
        print(f"Disconnected from MQTT broker unexpectedly (rc={reason_code}), will auto-reconnect")

def int_to_bit_array(n):
    if isinstance(n, int):
        return [int(b) for b in format(n, 'b').zfill(8)]

def main():
    global shutdown_requested, send_failure_count
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    with send_failure_lock:
        send_failure_count = 0

    bus = None
    client = None
    try:
        bus = can.interface.Bus(interface='socketcan', channel='can0', bitrate=500000)
        print("CAN bus initialized on can0")

        client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2, protocol=mqtt.MQTTv311, userdata=bus)
        client.on_connect = on_connect
        client.on_subscribe = on_subscribe
        client.on_message = on_message
        client.on_disconnect = on_disconnect
        # Set username/password authentication
        client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)

        # Configure TLS with CA certificate verification
        client.tls_set(
            ca_certs=MQTT_CA_CERT_PATH,
            certfile=None,
            keyfile=None,
            cert_reqs=ssl.CERT_REQUIRED,
            tls_version=ssl.PROTOCOL_TLSv1_2
        )
        # Paho auto-reconnects on disconnect; on_connect re-subscribes
        client.reconnect_delay_set(min_delay=1, max_delay=30)
        client.connect(MQTT_BROKER, MQTT_PORT, 60)
        client.loop_start()
        while not shutdown_requested:
            # Timeout lets the loop check shutdown_requested periodically
            message = bus.recv(timeout=1.0)
            if message is not None:
                frame_id = message.arbitration_id
                data = message.data
                data_length_code = message.dlc
                timestamp = message.timestamp

                # Convert the CAN ID to hexadecimal for easier reading
                hex_id = "0x" + format(frame_id, '03x')

                # Create MQTT message
                mqtt_message = {
                    "identifier": hex_id,
                    "data_length_code": data_length_code,
                    "data": [int_to_bit_array(x) for x in data],
                    "timestamp": timestamp
                }
                json_payload = json.dumps(mqtt_message)
                client.publish(MQTT_INBOUND_TOPIC, json_payload)

            # Check if CAN send has been failing consistently
            with send_failure_lock:
                if send_failure_count >= MAX_SEND_FAILURES:
                    raise RuntimeError(f"CAN bus send failed {send_failure_count} consecutive times, restarting")
        print("Shutdown complete")
    except Exception as e:
        print(f"Error: {e}")
        raise
    finally:
        if client:
            client.loop_stop()
            client.disconnect()
        if bus:
            bus.shutdown()

if __name__ == "__main__":
    retry_count = 0
    while retry_count < MAX_RETRIES and not shutdown_requested:
        try:
            main()
            if shutdown_requested:
                break
            retry_count = 0
            time.sleep(5)
        except Exception as e:
            retry_count += 1
            print(f"Error in main loop. Retrying ({retry_count}/{MAX_RETRIES})...")
            with open("crash.log","a") as f:
                f.write(f"\n---\nError: {e}\n")
                f.write(traceback.format_exc())
            time.sleep(30)
    if retry_count >= MAX_RETRIES:
        print(f"Failed after {MAX_RETRIES} retries.")
        sys.exit(1)