packer {
  required_plugins {
    amazon = {
      version = ">= 1.2.8"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "instance_type" {
  type    = string
  default = "t3.micro"  // Use smaller instance for building
}

variable "ami_name_prefix" {
  type    = string
  default = "ngu-event-monitor"
}

variable "stage" {
  type    = string
  default = "staging"
}

locals {
  timestamp = regex_replace(timestamp(), "[- TZ:]", "")
}

source "amazon-ebs" "event-monitor" {
  ami_name        = "${var.ami_name_prefix}-${var.stage}-${local.timestamp}"
  instance_type   = var.instance_type
  region          = var.aws_region
  
  // Use Amazon Linux 2023 as base
  source_ami_filter {
    filters = {
      name                = "al2023-ami-2023.*-x86_64"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    most_recent = true
    owners      = ["amazon"]
  }

  ssh_username = "ec2-user"

  tags = {
    Name        = "${var.ami_name_prefix}-${var.stage}"
    Environment = var.stage
    BuildDate   = timestamp()
    Project     = "ngu"
    Service     = "event-monitor"
  }

  // Add launch block device mapping
  launch_block_device_mappings {
    device_name = "/dev/xvda"
    volume_size = 20
    volume_type = "gp3"
    delete_on_termination = true
  }
}

build {
  name = "ngu-event-monitor"
  sources = ["source.amazon-ebs.event-monitor"]

  // Copy necessary files
  provisioner "file" {
    source      = "../scripts/event-monitor.service"
    destination = "/tmp/event-monitor.service"
  }

  // Install required packages and configure system
  provisioner "shell" {
    script = "setup.sh"
    environment_vars = [
      "STAGE=${var.stage}",
      "NODE_VERSION=18"
    ]
  }
} 