#include <Arduino.h>
#include <ESP32Servo.h>

// ============ إعدادات قابلة للتعديل بسهولة ============
#define SERVO_CENTER  96   // الوضع المستقيم
#define SERVO_LEFT    65   // أقصى يسار
#define SERVO_RIGHT   127  // أقصى يمين
// =======================================================

// ---- DC Drive Motor Pins ----
#define MOTOR_PIN1 4
#define MOTOR_PIN2 5

#define PWM_FREQ 5000
#define PWM_RES  8
#define CH_M1 0
#define CH_M2 1

// ---- Servo ----
#define SERVO_PIN 7
Servo steeringServo;

// ---- Stepper Pins (ULN2003) — بدون تغيير ----
#define PAN_IN1 15
#define PAN_IN2 16
#define PAN_IN3 17
#define PAN_IN4 18

#define TILT_IN1 8
#define TILT_IN2 9
#define TILT_IN3 10
#define TILT_IN4 11

#define STEP_DELAY_MS 3

const uint8_t stepSequence[4][4] = {
  {1, 0, 0, 0},
  {0, 1, 0, 0},
  {0, 0, 1, 0},
  {0, 0, 0, 1}
};

int panStepIndex = 0;
int tiltStepIndex = 0;
unsigned long lastPanStepTime = 0;
unsigned long lastTiltStepTime = 0;

// ---- Protocol ----
// [START][driveSpeed: int8][steer: int8 -1/0/1][pan: int8][tilt: int8][checksum]
#define PACKET_START 0xAA
#define PACKET_SIZE  6

uint8_t buffer[PACKET_SIZE];
uint8_t bufIndex = 0;
bool receiving = false;

int8_t currentSteer = 0;
int8_t currentPan = 0;
int8_t currentTilt = 0;

unsigned long lastPacketTime = 0;
#define TIMEOUT_MS 500

uint8_t calcChecksum(uint8_t* data, size_t len) {
  uint8_t chk = 0;
  for (size_t i = 0; i < len; i++) chk ^= data[i];
  return chk;
}

// ---- Drive Motor ----
void setDriveMotor(int8_t speed) {
  speed = constrain(speed, -100, 100);
  int duty = map(abs(speed), 0, 100, 0, 255);

  if (speed > 0) {
    ledcWrite(CH_M1, duty);
    ledcWrite(CH_M2, 0);
  } else if (speed < 0) {
    ledcWrite(CH_M1, 0);
    ledcWrite(CH_M2, duty);
  } else {
    ledcWrite(CH_M1, 0);
    ledcWrite(CH_M2, 0);
  }
}

// ---- Steering ----
void updateSteering(int8_t steer) {
  steer = constrain(steer, -100, 100);
  int angle;
  if (steer >= 0) {
    angle = SERVO_CENTER + (long)steer * (SERVO_RIGHT - SERVO_CENTER) / 100;
  } else {
    angle = SERVO_CENTER + (long)steer * (SERVO_CENTER - SERVO_LEFT) / 100;
  }
  steeringServo.write(angle);
}

// ---- Steppers (بدون تغيير) ----
void writeStepperPins(int in1, int in2, int in3, int in4, const uint8_t* seq) {
  digitalWrite(in1, seq[0]);
  digitalWrite(in2, seq[1]);
  digitalWrite(in3, seq[2]);
  digitalWrite(in4, seq[3]);
}

void updateStepper(int8_t direction, int* stepIndex, unsigned long* lastStepTime,
                    int in1, int in2, int in3, int in4) {
  if (direction == 0) return;

  unsigned long now = millis();
  if (now - *lastStepTime < STEP_DELAY_MS) return;

  *lastStepTime = now;
  *stepIndex += (direction > 0) ? 1 : -1;
  if (*stepIndex > 3) *stepIndex = 0;
  if (*stepIndex < 0) *stepIndex = 3;

  writeStepperPins(in1, in2, in3, in4, stepSequence[*stepIndex]);
}

void stopStepper(int in1, int in2, int in3, int in4) {
  digitalWrite(in1, LOW);
  digitalWrite(in2, LOW);
  digitalWrite(in3, LOW);
  digitalWrite(in4, LOW);
}

void parsePacket(uint8_t* data) {
  int8_t driveSpeed = (int8_t)data[1];
  currentSteer      = (int8_t)data[2];
  currentPan        = (int8_t)data[3];
  currentTilt       = (int8_t)data[4];

  setDriveMotor(driveSpeed);
  updateSteering(currentSteer);

  lastPacketTime = millis();

  Serial.printf("Drive=%d  Steer=%d  Pan=%d  Tilt=%d\n",
                driveSpeed, currentSteer, currentPan, currentTilt);
}

void setup() {
  Serial.begin(115200);
  USBSerial.begin(115200);

  // Drive motor
  ledcSetup(CH_M1, PWM_FREQ, PWM_RES);
  ledcAttachPin(MOTOR_PIN1, CH_M1);
  ledcSetup(CH_M2, PWM_FREQ, PWM_RES);
  ledcAttachPin(MOTOR_PIN2, CH_M2);
  setDriveMotor(0);

  // Servo
  steeringServo.setPeriodHertz(50);
  steeringServo.attach(SERVO_PIN, 500, 2500);
  steeringServo.write(SERVO_CENTER);

  // Steppers
  pinMode(PAN_IN1, OUTPUT);
  pinMode(PAN_IN2, OUTPUT);
  pinMode(PAN_IN3, OUTPUT);
  pinMode(PAN_IN4, OUTPUT);
  pinMode(TILT_IN1, OUTPUT);
  pinMode(TILT_IN2, OUTPUT);
  pinMode(TILT_IN3, OUTPUT);
  pinMode(TILT_IN4, OUTPUT);
  stopStepper(PAN_IN1, PAN_IN2, PAN_IN3, PAN_IN4);
  stopStepper(TILT_IN1, TILT_IN2, TILT_IN3, TILT_IN4);

  delay(1000);
  Serial.println("Car Controller Ready — Waiting for commands...");
}

void loop() {
  while (USBSerial.available()) {
    uint8_t b = USBSerial.read();

    if (!receiving) {
      if (b == PACKET_START) {
        receiving = true;
        bufIndex = 0;
        buffer[bufIndex++] = b;
      }
    } else {
      buffer[bufIndex++] = b;
      if (bufIndex >= PACKET_SIZE) {
        uint8_t chk = calcChecksum(buffer, PACKET_SIZE - 1);
        if (chk == buffer[PACKET_SIZE - 1]) {
          parsePacket(buffer);
        } else {
          Serial.println("Checksum error!");
        }
        receiving = false;
        bufIndex = 0;
      }
    }
  }

  updateStepper(currentPan, &panStepIndex, &lastPanStepTime,
                PAN_IN1, PAN_IN2, PAN_IN3, PAN_IN4);
  updateStepper(currentTilt, &tiltStepIndex, &lastTiltStepTime,
                TILT_IN1, TILT_IN2, TILT_IN3, TILT_IN4);

  if (millis() - lastPacketTime > TIMEOUT_MS && lastPacketTime != 0) {
    setDriveMotor(0);
    currentSteer = 0;
    updateSteering(0);
    currentPan = 0;
    currentTilt = 0;
  }
}