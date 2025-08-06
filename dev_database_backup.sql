/*M!999999\- enable the sandbox mode */ 
-- MariaDB dump 10.19  Distrib 10.6.22-MariaDB, for debian-linux-gnu (x86_64)
--
-- Host: localhost    Database: church_attendance
-- ------------------------------------------------------
-- Server version	10.6.22-MariaDB-ubu2004

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `attendance_records`
--

DROP TABLE IF EXISTS `attendance_records`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `attendance_records` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `session_id` int(11) NOT NULL,
  `individual_id` int(11) NOT NULL,
  `present` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_session_individual` (`session_id`,`individual_id`),
  KEY `idx_session` (`session_id`),
  KEY `idx_individual` (`individual_id`),
  KEY `idx_present` (`present`),
  CONSTRAINT `attendance_records_ibfk_1` FOREIGN KEY (`session_id`) REFERENCES `attendance_sessions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `attendance_records_ibfk_2` FOREIGN KEY (`individual_id`) REFERENCES `individuals` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=182 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `attendance_records`
--

LOCK TABLES `attendance_records` WRITE;
/*!40000 ALTER TABLE `attendance_records` DISABLE KEYS */;
INSERT INTO `attendance_records` VALUES (1,1,101,1),(2,1,102,1),(3,1,103,1),(4,1,40,1),(5,1,37,1),(6,1,38,1),(7,1,39,1),(8,1,68,1),(9,1,70,1),(10,1,67,1),(11,1,66,1),(12,1,69,1),(13,1,143,1),(14,1,142,1),(15,1,11,1),(16,1,10,1),(17,1,9,1),(18,1,13,1),(19,1,12,1),(20,1,84,1),(21,1,77,1),(22,1,80,1),(23,1,79,1),(24,1,78,1),(25,1,81,1),(26,1,50,1),(27,1,47,1),(28,1,46,1),(29,1,48,1),(30,1,49,1),(31,1,7,1),(32,1,8,1),(33,1,6,1),(34,1,33,1),(35,1,36,1),(36,1,35,1),(37,1,34,1),(38,1,32,1),(39,1,109,1),(40,1,105,1),(41,18,101,1),(42,18,102,1),(43,18,103,1),(44,18,99,1),(45,18,100,1),(46,18,104,1),(47,18,19,1),(48,18,22,1),(49,18,18,1),(50,18,20,1),(51,18,21,1),(52,18,26,1),(53,18,25,1),(54,18,23,1),(55,18,27,1),(56,18,24,1),(57,18,139,1),(58,18,142,1),(59,18,143,1),(60,18,141,1),(61,18,140,1),(62,18,97,1),(63,18,95,1),(64,18,94,1),(65,18,98,1),(66,18,93,1),(67,18,96,1),(68,18,130,1),(69,18,127,1),(70,18,129,1),(71,18,11,1),(72,18,10,1),(73,18,9,1),(74,18,13,1),(75,18,12,1),(76,18,59,1),(77,18,57,1),(78,18,58,1),(79,18,60,1),(80,18,61,1),(81,18,64,1),(82,18,65,1),(83,18,62,1),(84,18,63,1),(85,18,75,1),(86,18,73,1),(87,18,76,1),(88,18,72,1),(89,18,74,1),(90,18,71,1),(91,18,45,1),(92,18,44,1),(93,18,42,1),(94,18,43,1),(95,18,41,1),(96,18,87,1),(97,18,88,1),(98,18,17,1),(99,18,15,1),(100,18,14,1),(101,18,16,1),(102,18,119,1),(103,18,116,1),(104,18,117,1),(105,18,120,1),(106,18,118,1),(107,35,101,1),(108,35,102,1),(109,35,103,1),(110,35,99,1),(111,35,100,1),(112,35,104,1),(113,35,52,1),(114,35,51,1),(115,35,54,1),(116,35,55,1),(117,35,56,1),(118,35,53,1),(119,35,77,1),(120,35,80,1),(121,35,79,1),(122,35,78,1),(123,35,81,1),(124,35,86,1),(125,35,83,1),(126,35,84,1),(127,35,82,1),(128,35,85,1),(129,35,50,1),(130,35,47,1),(131,35,46,1),(132,35,48,1),(133,35,49,1),(134,41,101,1),(135,41,102,1),(136,41,103,1),(137,41,99,1),(138,41,100,1),(139,41,104,1),(140,41,19,1),(141,41,22,1),(142,41,18,1),(143,41,20,1),(144,41,21,1),(145,41,139,1),(146,41,142,1),(147,41,143,1),(148,41,141,1),(149,41,140,1),(150,41,86,1),(151,41,83,1),(152,41,84,1),(153,41,82,1),(154,41,85,1),(155,41,25,1),(156,41,26,1),(157,41,145,1),(158,41,115,1),(159,41,80,1),(160,41,40,1),(161,41,51,1),(162,41,134,1),(163,41,135,1),(164,41,37,1),(165,41,148,1),(166,41,57,1),(167,41,152,1),(168,41,28,1),(169,41,30,1),(170,41,31,1),(171,41,29,1),(172,41,75,1),(173,41,73,1),(174,41,76,1),(175,41,72,1),(176,41,74,1),(177,41,71,1),(178,41,6,1),(180,41,50,0);
/*!40000 ALTER TABLE `attendance_records` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `attendance_sessions`
--

DROP TABLE IF EXISTS `attendance_sessions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `attendance_sessions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `gathering_type_id` int(11) NOT NULL,
  `session_date` date NOT NULL,
  `created_by` int(11) NOT NULL,
  `notes` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_session` (`gathering_type_id`,`session_date`),
  KEY `created_by` (`created_by`),
  KEY `idx_gathering_date` (`gathering_type_id`,`session_date`),
  KEY `idx_date` (`session_date`),
  CONSTRAINT `attendance_sessions_ibfk_1` FOREIGN KEY (`gathering_type_id`) REFERENCES `gathering_types` (`id`) ON DELETE CASCADE,
  CONSTRAINT `attendance_sessions_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=65 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `attendance_sessions`
--

LOCK TABLES `attendance_sessions` WRITE;
/*!40000 ALTER TABLE `attendance_sessions` DISABLE KEYS */;
INSERT INTO `attendance_sessions` VALUES (1,1,'2025-07-27',2,NULL,'2025-08-04 03:07:14','2025-08-04 03:14:39'),(18,1,'2025-07-20',2,NULL,'2025-08-04 20:46:14','2025-08-04 20:46:33'),(35,1,'2025-07-06',2,NULL,'2025-08-04 20:46:59','2025-08-04 20:47:43'),(41,1,'2025-07-13',2,NULL,'2025-08-04 20:53:11','2025-08-05 20:30:23');
/*!40000 ALTER TABLE `attendance_sessions` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `audit_log`
--

DROP TABLE IF EXISTS `audit_log`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `audit_log` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) DEFAULT NULL,
  `action` varchar(255) NOT NULL,
  `table_name` varchar(100) DEFAULT NULL,
  `record_id` int(11) DEFAULT NULL,
  `old_values` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`old_values`)),
  `new_values` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`new_values`)),
  `ip_address` varchar(45) DEFAULT NULL,
  `user_agent` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_action` (`action`),
  KEY `idx_created` (`created_at`),
  CONSTRAINT `audit_log_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=11 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `audit_log`
--

LOCK TABLES `audit_log` WRITE;
/*!40000 ALTER TABLE `audit_log` DISABLE KEYS */;
INSERT INTO `audit_log` VALUES (6,2,'RECORD_ATTENDANCE',NULL,NULL,NULL,'{\"attendanceRecords\":[{\"individualId\":115,\"present\":true}],\"visitors\":[]}','::ffff:172.30.0.5','Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36','2025-08-05 04:42:38'),(7,2,'RECORD_ATTENDANCE',NULL,NULL,NULL,'{\"attendanceRecords\":[{\"individualId\":80,\"present\":true}],\"visitors\":[]}','::ffff:172.30.0.5','Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36','2025-08-05 04:42:39'),(8,2,'RECORD_ATTENDANCE','attendance_sessions',NULL,NULL,'{\"attendanceRecords\":[{\"individualId\":40,\"present\":true}],\"visitors\":[],\"serviceName\":\"Sunday Morning Service\",\"serviceDate\":\"2025-07-13\",\"actionCount\":1,\"firstAction\":\"2025-08-05T04:45:49.174Z\"}','::ffff:172.30.0.5','Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36','2025-08-05 04:45:49'),(9,2,'RECORD_ATTENDANCE','attendance_sessions',NULL,NULL,'{\"attendanceRecords\":[{\"individualId\":37,\"present\":true}],\"visitors\":[],\"serviceName\":\"Sunday Morning Service\",\"serviceDate\":\"2025-07-13\",\"actionCount\":1,\"firstAction\":\"2025-08-05T04:52:15.813Z\"}','::ffff:172.30.0.5','Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36','2025-08-05 04:52:15'),(10,2,'RECORD_ATTENDANCE','attendance_sessions',NULL,NULL,'{\"attendanceRecords\":[{\"individualId\":50,\"present\":true}],\"visitors\":[],\"serviceName\":\"Sunday Morning Service\",\"serviceDate\":\"2025-07-13\",\"actionCount\":1,\"firstAction\":\"2025-08-05T20:30:22.810Z\"}','::ffff:172.30.0.5','Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36','2025-08-05 20:30:22');
/*!40000 ALTER TABLE `audit_log` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `church_settings`
--

DROP TABLE IF EXISTS `church_settings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `church_settings` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `church_name` varchar(255) NOT NULL,
  `country_code` varchar(2) DEFAULT 'AU',
  `timezone` varchar(100) DEFAULT 'Australia/Sydney',
  `default_gathering_duration` int(11) DEFAULT 90,
  `onboarding_completed` tinyint(1) DEFAULT 0,
  `brevo_api_key` varchar(255) DEFAULT NULL,
  `email_from_name` varchar(255) DEFAULT 'Let My People Grow',
  `email_from_address` varchar(255) DEFAULT 'noreply@redeemercc.org.au',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `church_settings`
--

LOCK TABLES `church_settings` WRITE;
/*!40000 ALTER TABLE `church_settings` DISABLE KEYS */;
INSERT INTO `church_settings` VALUES (1,'Development Church','AU','Australia/Sydney',90,1,NULL,'Let My People Grow','dev@church.local','2025-08-04 01:44:26','2025-08-04 01:44:26');
/*!40000 ALTER TABLE `church_settings` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `families`
--

DROP TABLE IF EXISTS `families`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `families` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `family_name` varchar(255) NOT NULL,
  `family_identifier` varchar(100) DEFAULT NULL,
  `familyType` varchar(20) DEFAULT 'regular',
  `lastAttended` date DEFAULT NULL,
  `created_by` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `created_by` (`created_by`),
  KEY `idx_family_name` (`family_name`),
  KEY `idx_identifier` (`family_identifier`),
  KEY `idx_families_last_attended` (`lastAttended`),
  KEY `idx_families_family_type` (`familyType`),
  CONSTRAINT `families_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=33 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `families`
--

LOCK TABLES `families` WRITE;
/*!40000 ALTER TABLE `families` DISABLE KEYS */;
INSERT INTO `families` VALUES (1,'Smith, John and Jane',NULL,'regular',NULL,NULL,'2025-08-03 23:05:49','2025-08-03 23:05:49'),(2,'Johnson, Mike',NULL,'regular',NULL,NULL,'2025-08-03 23:05:49','2025-08-03 23:05:49'),(3,'Williams, David and Sarah',NULL,'regular',NULL,NULL,'2025-08-03 23:05:49','2025-08-03 23:05:49'),(4,'Smith, John and Sarah','Smith, John and Sarah','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(5,'Johnson, Michael and Jennifer','Johnson, Michael and Jennifer','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(6,'Williams, Robert and Lisa','Williams, Robert and Lisa','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(7,'Brown, David and Amanda','Brown, David and Amanda','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(8,'Davis, Christopher and Michelle','Davis, Christopher and Michelle','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(9,'Miller, Daniel and Stephanie','Miller, Daniel and Stephanie','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(10,'Wilson, Matthew and Ashley','Wilson, Matthew and Ashley','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(11,'Anderson, Andrew and Kimberly','Anderson, Andrew and Kimberly','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(12,'Taylor, Joshua and Emily','Taylor, Joshua and Emily','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(13,'Thomas, Ryan and Jessica','Thomas, Ryan and Jessica','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(14,'Garcia, Anthony and Amanda','Garcia, Anthony and Amanda','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(15,'Martinez, Kevin and Nicole','Martinez, Kevin and Nicole','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(16,'Robinson, Brian and Lauren','Robinson, Brian and Lauren','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(17,'Clark, Steven and Rachel','Clark, Steven and Rachel','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(18,'Rodriguez, Timothy and Heather','Rodriguez, Timothy and Heather','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(19,'Lewis, Jeffrey and Melissa','Lewis, Jeffrey and Melissa','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(20,'Lee, Mark and Christine','Lee, Mark and Christine','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(21,'Walker, Donald and Deborah','Walker, Donald and Deborah','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(22,'Hall, Paul and Lisa','Hall, Paul and Lisa','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(23,'Allen, Mark and Nancy','Allen, Mark and Nancy','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(24,'Young, James and Karen','Young, James and Karen','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(25,'King, John and Betty','King, John and Betty','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(26,'Wright, David and Helen','Wright, David and Helen','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(27,'Lopez, Richard and Sandra','Lopez, Richard and Sandra','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(28,'Hill, Joseph and Donna','Hill, Joseph and Donna','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(29,'Scott, Thomas and Carol','Scott, Thomas and Carol','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(30,'Green, Christopher and Ruth','Green, Christopher and Ruth','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(31,'Baker, Daniel and Sharon','Baker, Daniel and Sharon','regular',NULL,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(32,'Smitty McSmitface Family',NULL,'regular',NULL,2,'2025-08-04 20:47:43','2025-08-04 20:47:43');
/*!40000 ALTER TABLE `families` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `gathering_lists`
--

DROP TABLE IF EXISTS `gathering_lists`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `gathering_lists` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `gathering_type_id` int(11) NOT NULL,
  `individual_id` int(11) NOT NULL,
  `added_by` int(11) DEFAULT NULL,
  `added_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_gathering_individual` (`gathering_type_id`,`individual_id`),
  KEY `added_by` (`added_by`),
  KEY `idx_gathering_type` (`gathering_type_id`),
  KEY `idx_individual` (`individual_id`),
  CONSTRAINT `gathering_lists_ibfk_1` FOREIGN KEY (`gathering_type_id`) REFERENCES `gathering_types` (`id`) ON DELETE CASCADE,
  CONSTRAINT `gathering_lists_ibfk_2` FOREIGN KEY (`individual_id`) REFERENCES `individuals` (`id`) ON DELETE CASCADE,
  CONSTRAINT `gathering_lists_ibfk_3` FOREIGN KEY (`added_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=147 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `gathering_lists`
--

LOCK TABLES `gathering_lists` WRITE;
/*!40000 ALTER TABLE `gathering_lists` DISABLE KEYS */;
INSERT INTO `gathering_lists` VALUES (1,1,6,2,'2025-08-04 02:30:09'),(2,1,7,2,'2025-08-04 02:30:09'),(3,1,8,2,'2025-08-04 02:30:09'),(4,1,9,2,'2025-08-04 02:30:09'),(5,1,10,2,'2025-08-04 02:30:09'),(6,1,11,2,'2025-08-04 02:30:09'),(7,1,12,2,'2025-08-04 02:30:09'),(8,1,13,2,'2025-08-04 02:30:09'),(9,1,14,2,'2025-08-04 02:30:09'),(10,1,15,2,'2025-08-04 02:30:09'),(11,1,16,2,'2025-08-04 02:30:09'),(12,1,17,2,'2025-08-04 02:30:09'),(13,1,18,2,'2025-08-04 02:30:09'),(14,1,19,2,'2025-08-04 02:30:09'),(15,1,20,2,'2025-08-04 02:30:09'),(16,1,21,2,'2025-08-04 02:30:09'),(17,1,22,2,'2025-08-04 02:30:09'),(18,1,23,2,'2025-08-04 02:30:09'),(19,1,24,2,'2025-08-04 02:30:09'),(20,1,25,2,'2025-08-04 02:30:09'),(21,1,26,2,'2025-08-04 02:30:09'),(22,1,27,2,'2025-08-04 02:30:09'),(23,1,28,2,'2025-08-04 02:30:09'),(24,1,29,2,'2025-08-04 02:30:09'),(25,1,30,2,'2025-08-04 02:30:09'),(26,1,31,2,'2025-08-04 02:30:09'),(27,1,32,2,'2025-08-04 02:30:09'),(28,1,33,2,'2025-08-04 02:30:09'),(29,1,34,2,'2025-08-04 02:30:09'),(30,1,35,2,'2025-08-04 02:30:09'),(31,1,36,2,'2025-08-04 02:30:09'),(32,1,37,2,'2025-08-04 02:30:09'),(33,1,38,2,'2025-08-04 02:30:09'),(34,1,39,2,'2025-08-04 02:30:09'),(35,1,40,2,'2025-08-04 02:30:09'),(36,1,41,2,'2025-08-04 02:30:09'),(37,1,42,2,'2025-08-04 02:30:09'),(38,1,43,2,'2025-08-04 02:30:09'),(39,1,44,2,'2025-08-04 02:30:09'),(40,1,45,2,'2025-08-04 02:30:09'),(41,1,46,2,'2025-08-04 02:30:09'),(42,1,47,2,'2025-08-04 02:30:09'),(43,1,48,2,'2025-08-04 02:30:09'),(44,1,49,2,'2025-08-04 02:30:09'),(45,1,50,2,'2025-08-04 02:30:09'),(46,1,51,2,'2025-08-04 02:30:09'),(47,1,52,2,'2025-08-04 02:30:09'),(48,1,53,2,'2025-08-04 02:30:09'),(49,1,54,2,'2025-08-04 02:30:09'),(50,1,55,2,'2025-08-04 02:30:09'),(51,1,56,2,'2025-08-04 02:30:09'),(52,1,57,2,'2025-08-04 02:30:09'),(53,1,58,2,'2025-08-04 02:30:09'),(54,1,59,2,'2025-08-04 02:30:09'),(55,1,60,2,'2025-08-04 02:30:09'),(56,1,61,2,'2025-08-04 02:30:09'),(57,1,62,2,'2025-08-04 02:30:09'),(58,1,63,2,'2025-08-04 02:30:09'),(59,1,64,2,'2025-08-04 02:30:09'),(60,1,65,2,'2025-08-04 02:30:09'),(61,1,66,2,'2025-08-04 02:30:09'),(62,1,67,2,'2025-08-04 02:30:09'),(63,1,68,2,'2025-08-04 02:30:09'),(64,1,69,2,'2025-08-04 02:30:09'),(65,1,70,2,'2025-08-04 02:30:09'),(66,1,71,2,'2025-08-04 02:30:09'),(67,1,72,2,'2025-08-04 02:30:09'),(68,1,73,2,'2025-08-04 02:30:09'),(69,1,74,2,'2025-08-04 02:30:09'),(70,1,75,2,'2025-08-04 02:30:09'),(71,1,76,2,'2025-08-04 02:30:09'),(72,1,77,2,'2025-08-04 02:30:09'),(73,1,78,2,'2025-08-04 02:30:09'),(74,1,79,2,'2025-08-04 02:30:09'),(75,1,80,2,'2025-08-04 02:30:09'),(76,1,81,2,'2025-08-04 02:30:09'),(77,1,82,2,'2025-08-04 02:30:09'),(78,1,83,2,'2025-08-04 02:30:09'),(79,1,84,2,'2025-08-04 02:30:09'),(80,1,85,2,'2025-08-04 02:30:09'),(81,1,86,2,'2025-08-04 02:30:09'),(82,1,87,2,'2025-08-04 02:30:09'),(83,1,88,2,'2025-08-04 02:30:09'),(84,1,89,2,'2025-08-04 02:30:09'),(85,1,90,2,'2025-08-04 02:30:09'),(86,1,91,2,'2025-08-04 02:30:09'),(87,1,92,2,'2025-08-04 02:30:09'),(88,1,93,2,'2025-08-04 02:30:09'),(89,1,94,2,'2025-08-04 02:30:09'),(90,1,95,2,'2025-08-04 02:30:09'),(91,1,96,2,'2025-08-04 02:30:09'),(92,1,97,2,'2025-08-04 02:30:09'),(93,1,98,2,'2025-08-04 02:30:09'),(94,1,99,2,'2025-08-04 02:30:09'),(95,1,100,2,'2025-08-04 02:30:09'),(96,1,101,2,'2025-08-04 02:30:09'),(97,1,102,2,'2025-08-04 02:30:09'),(98,1,103,2,'2025-08-04 02:30:09'),(99,1,104,2,'2025-08-04 02:30:09'),(100,1,105,2,'2025-08-04 02:30:09'),(101,1,106,2,'2025-08-04 02:30:09'),(102,1,107,2,'2025-08-04 02:30:09'),(103,1,108,2,'2025-08-04 02:30:09'),(104,1,109,2,'2025-08-04 02:30:09'),(105,1,110,2,'2025-08-04 02:30:09'),(106,1,111,2,'2025-08-04 02:30:09'),(107,1,112,2,'2025-08-04 02:30:09'),(108,1,113,2,'2025-08-04 02:30:09'),(109,1,114,2,'2025-08-04 02:30:09'),(110,1,115,2,'2025-08-04 02:30:09'),(111,1,116,2,'2025-08-04 02:30:09'),(112,1,117,2,'2025-08-04 02:30:09'),(113,1,118,2,'2025-08-04 02:30:09'),(114,1,119,2,'2025-08-04 02:30:09'),(115,1,120,2,'2025-08-04 02:30:09'),(116,1,121,2,'2025-08-04 02:30:09'),(117,1,122,2,'2025-08-04 02:30:09'),(118,1,123,2,'2025-08-04 02:30:09'),(119,1,124,2,'2025-08-04 02:30:09'),(120,1,125,2,'2025-08-04 02:30:09'),(121,1,126,2,'2025-08-04 02:30:09'),(122,1,127,2,'2025-08-04 02:30:09'),(123,1,128,2,'2025-08-04 02:30:09'),(124,1,129,2,'2025-08-04 02:30:09'),(125,1,130,2,'2025-08-04 02:30:09'),(126,1,131,2,'2025-08-04 02:30:09'),(127,1,132,2,'2025-08-04 02:30:09'),(128,1,133,2,'2025-08-04 02:30:09'),(129,1,134,2,'2025-08-04 02:30:09'),(130,1,135,2,'2025-08-04 02:30:09'),(131,1,136,2,'2025-08-04 02:30:09'),(132,1,137,2,'2025-08-04 02:30:09'),(133,1,138,2,'2025-08-04 02:30:09'),(134,1,139,2,'2025-08-04 02:30:09'),(135,1,140,2,'2025-08-04 02:30:09'),(136,1,141,2,'2025-08-04 02:30:09'),(137,1,142,2,'2025-08-04 02:30:09'),(138,1,143,2,'2025-08-04 02:30:09'),(139,1,144,2,'2025-08-04 02:30:09'),(140,1,145,2,'2025-08-04 02:30:09'),(141,1,146,2,'2025-08-04 02:30:09'),(142,1,147,2,'2025-08-04 02:30:09'),(143,1,148,2,'2025-08-04 02:30:09'),(144,1,149,2,'2025-08-04 02:30:09'),(145,1,152,2,'2025-08-04 20:47:43'),(146,1,153,2,'2025-08-04 20:47:43');
/*!40000 ALTER TABLE `gathering_lists` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `gathering_types`
--

DROP TABLE IF EXISTS `gathering_types`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `gathering_types` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `description` text DEFAULT NULL,
  `day_of_week` enum('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday') DEFAULT NULL,
  `start_time` time DEFAULT NULL,
  `duration_minutes` int(11) DEFAULT 90,
  `frequency` enum('weekly','biweekly','monthly') DEFAULT 'weekly',
  `group_by_family` tinyint(1) DEFAULT 1,
  `is_active` tinyint(1) DEFAULT 1,
  `created_by` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `created_by` (`created_by`),
  KEY `idx_name` (`name`),
  KEY `idx_active` (`is_active`),
  CONSTRAINT `gathering_types_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `gathering_types`
--

LOCK TABLES `gathering_types` WRITE;
/*!40000 ALTER TABLE `gathering_types` DISABLE KEYS */;
INSERT INTO `gathering_types` VALUES (1,'Sunday Morning Service','Main worship service on Sunday mornings at 10:00 AM','Sunday','10:00:00',90,'weekly',1,1,NULL,'2025-08-03 23:05:49','2025-08-04 03:06:50'),(2,'Youth Group','Weekly youth ministry gathering','Friday','19:00:00',90,'weekly',1,1,NULL,'2025-08-03 23:05:49','2025-08-04 03:06:55');
/*!40000 ALTER TABLE `gathering_types` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `individuals`
--

DROP TABLE IF EXISTS `individuals`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `individuals` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `first_name` varchar(100) NOT NULL,
  `last_name` varchar(100) NOT NULL,
  `family_id` int(11) DEFAULT NULL,
  `date_of_birth` date DEFAULT NULL,
  `is_regular_attendee` tinyint(1) DEFAULT 1,
  `is_visitor` tinyint(1) DEFAULT 0,
  `notes` text DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  `created_by` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `created_by` (`created_by`),
  KEY `idx_name` (`last_name`,`first_name`),
  KEY `idx_family` (`family_id`),
  KEY `idx_active` (`is_active`),
  KEY `idx_regular` (`is_regular_attendee`),
  KEY `idx_is_visitor` (`is_visitor`),
  CONSTRAINT `individuals_ibfk_1` FOREIGN KEY (`family_id`) REFERENCES `families` (`id`) ON DELETE SET NULL,
  CONSTRAINT `individuals_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=154 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `individuals`
--

LOCK TABLES `individuals` WRITE;
/*!40000 ALTER TABLE `individuals` DISABLE KEYS */;
INSERT INTO `individuals` VALUES (1,'John','Smith',1,NULL,1,0,NULL,1,NULL,'2025-08-03 23:05:49','2025-08-03 23:05:49'),(2,'Jane','Smith',1,NULL,1,0,NULL,1,NULL,'2025-08-03 23:05:49','2025-08-03 23:05:49'),(3,'Mike','Johnson',2,NULL,1,0,NULL,1,NULL,'2025-08-03 23:05:49','2025-08-03 23:05:49'),(4,'Sarah','Williams',3,NULL,1,0,NULL,1,NULL,'2025-08-03 23:05:49','2025-08-03 23:05:49'),(5,'David','Williams',3,NULL,1,0,NULL,1,NULL,'2025-08-03 23:05:49','2025-08-03 23:05:49'),(6,'Sarah','Smith',4,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(7,'Emma','Smith',4,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(8,'Liam','Smith',4,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(9,'Michael','Johnson',5,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(10,'Jennifer','Johnson',5,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(11,'David','Johnson',5,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(12,'Olivia','Johnson',5,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(13,'Noah','Johnson',5,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(14,'Robert','Williams',6,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(15,'Lisa','Williams',6,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(16,'Sophia','Williams',6,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(17,'James','Williams',6,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(18,'David','Brown',7,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(19,'Amanda','Brown',7,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(20,'Isabella','Brown',7,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(21,'William','Brown',7,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(22,'Charlotte','Brown',7,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(23,'Christopher','Davis',8,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(24,'Michelle','Davis',8,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(25,'Benjamin','Davis',8,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(26,'Ava','Davis',8,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(27,'Elijah','Davis',8,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(28,'Daniel','Miller',9,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(29,'Stephanie','Miller',9,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(30,'Lucas','Miller',9,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(31,'Mia','Miller',9,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(32,'Matthew','Wilson',10,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(33,'Ashley','Wilson',10,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(34,'Mason','Wilson',10,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(35,'Harper','Wilson',10,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(36,'Evelyn','Wilson',10,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(37,'Andrew','Anderson',11,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(38,'Kimberly','Anderson',11,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(39,'Logan','Anderson',11,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(40,'Abigail','Anderson',11,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(41,'Joshua','Taylor',12,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(42,'Emily','Taylor',12,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(43,'Jacob','Taylor',12,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(44,'Elizabeth','Taylor',12,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(45,'Alexander','Taylor',12,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(46,'Ryan','Thomas',13,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(47,'Jessica','Thomas',13,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(48,'Samuel','Thomas',13,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(49,'Sofia','Thomas',13,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(50,'Henry','Thomas',13,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(51,'Anthony','Garcia',14,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(52,'Amanda','Garcia',14,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(53,'Owen','Garcia',14,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(54,'Avery','Garcia',14,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(55,'Daniel','Garcia',14,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(56,'Ella','Garcia',14,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(57,'Kevin','Martinez',15,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(58,'Nicole','Martinez',15,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(59,'Jack','Martinez',15,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(60,'Scarlett','Martinez',15,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(61,'Brian','Robinson',16,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(62,'Lauren','Robinson',16,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(63,'Luke','Robinson',16,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(64,'Chloe','Robinson',16,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(65,'Isaac','Robinson',16,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(66,'Steven','Clark',17,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(67,'Rachel','Clark',17,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(68,'Gabriel','Clark',17,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(69,'Zoe','Clark',17,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(70,'Julian','Clark',17,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(71,'Timothy','Rodriguez',18,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(72,'Heather','Rodriguez',18,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(73,'Carter','Rodriguez',18,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(74,'Lily','Rodriguez',18,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(75,'Adrian','Rodriguez',18,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(76,'Hannah','Rodriguez',18,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(77,'Jeffrey','Lewis',19,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(78,'Melissa','Lewis',19,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(79,'Leo','Lewis',19,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(80,'Layla','Lewis',19,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(81,'Nathan','Lewis',19,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(82,'Mark','Lee',20,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(83,'Christine','Lee',20,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(84,'Isaac','Lee',20,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(85,'Riley','Lee',20,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(86,'Christian','Lee',20,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(87,'Donald','Walker',21,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(88,'Deborah','Walker',21,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(89,'Aaron','Walker',21,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(90,'Nora','Walker',21,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(91,'Andrew','Walker',21,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(92,'Zoey','Walker',21,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(93,'Paul','Hall',22,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(94,'Lisa','Hall',22,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(95,'Elijah','Hall',22,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(96,'Penelope','Hall',22,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(97,'Christopher','Hall',22,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(98,'Luna','Hall',22,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(99,'Mark','Allen',23,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(100,'Nancy','Allen',23,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(101,'Charles','Allen',23,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(102,'Eleanor','Allen',23,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(103,'Josiah','Allen',23,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(104,'Savannah','Allen',23,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(105,'James','Young',24,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(106,'Karen','Young',24,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(107,'Caleb','Young',24,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(108,'Victoria','Young',24,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(109,'Isaiah','Young',24,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(110,'John','King',25,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(111,'Betty','King',25,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(112,'Thomas','King',25,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(113,'Stella','King',25,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(114,'Ryan','King',25,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(115,'Violet','King',25,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(116,'David','Wright',26,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(117,'Helen','Wright',26,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(118,'Jeremiah','Wright',26,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(119,'Aurora','Wright',26,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(120,'Hunter','Wright',26,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(121,'Richard','Lopez',27,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(122,'Sandra','Lopez',27,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(123,'Eli','Lopez',27,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(124,'Natalie','Lopez',27,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(125,'Connor','Lopez',27,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(126,'Lucia','Lopez',27,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(127,'Joseph','Hill',28,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(128,'Donna','Hill',28,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(129,'Josiah','Hill',28,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(130,'Grace','Hill',28,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(131,'Landon','Hill',28,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(132,'Chloe','Hill',28,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(133,'Thomas','Scott',29,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(134,'Carol','Scott',29,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(135,'Adrian','Scott',29,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(136,'Scarlett','Scott',29,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(137,'Jonathan','Scott',29,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(138,'Stella','Scott',29,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(139,'Christopher','Green',30,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(140,'Ruth','Green',30,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(141,'Robert','Green',30,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(142,'Hazel','Green',30,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(143,'Nicholas','Green',30,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(144,'Daniel','Baker',31,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(145,'Sharon','Baker',31,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(146,'Sean','Baker',31,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(147,'Lucy','Baker',31,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(148,'Isaac','Baker',31,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(149,'Aria','Baker',31,NULL,1,0,NULL,1,2,'2025-08-04 02:30:09','2025-08-04 02:30:09'),(151,'Jackie','Chan',NULL,NULL,1,1,NULL,1,2,'2025-08-04 03:14:39','2025-08-04 03:14:39'),(152,'Smitty','McSmitface',32,NULL,1,1,NULL,1,2,'2025-08-04 20:47:43','2025-08-04 20:47:43'),(153,'Judy','McSmitface',32,NULL,1,1,NULL,1,2,'2025-08-04 20:47:43','2025-08-04 20:47:43');
/*!40000 ALTER TABLE `individuals` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `migrations`
--

DROP TABLE IF EXISTS `migrations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `migrations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `version` varchar(50) NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` text DEFAULT NULL,
  `executed_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `execution_time_ms` int(11) DEFAULT NULL,
  `status` enum('success','failed') DEFAULT 'success',
  `error_message` text DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `version` (`version`)
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `migrations`
--

LOCK TABLES `migrations` WRITE;
/*!40000 ALTER TABLE `migrations` DISABLE KEYS */;
INSERT INTO `migrations` VALUES (1,'001_fix_audit_log','001_fix_audit_log.sql','Fix audit_log table structure - add entity_type and entity_id columns','2025-08-04 02:29:10',0,'success',NULL),(2,'002_add_contact_fields','002_add_contact_fields.sql','Add is_visitor flag to individuals table','2025-08-04 02:29:10',0,'success',NULL),(3,'003_enhance_visitors_table','003_enhance_visitors_table.sql','Enhance visitors table with additional fields','2025-08-04 02:29:10',0,'success',NULL),(4,'004_fix_attendance_duplicates','004_fix_attendance_duplicates.sql','Migration 004_fix_attendance_duplicates','2025-08-04 02:29:10',0,'success',NULL),(5,'005_add_attendance_updated_at','005_add_attendance_updated_at.sql','Migration 005_add_attendance_updated_at','2025-08-04 02:29:10',0,'success',NULL),(6,'006_add_church_isolation','006_add_church_isolation.sql','Migration 006_add_church_isolation','2025-08-04 02:29:10',2,'failed','(conn:140, no: 1054, SQLState: 42S22) Unknown column \'gt.church_id\' in \'SET\'\nsql: UPDATE gathering_types gt \nJOIN church_settings cs ON cs.id = (SELECT MIN(id) FROM church_settings)\nSET gt.church_id = cs.church_id \nWHERE gt.church_id IS NULL OR gt.church_id = \'\'; - parameters:[]'),(7,'007_add_data_access_setting','007_add_data_access_setting.sql','Migration 007_add_data_access_setting','2025-08-04 02:29:10',0,'success',NULL),(8,'008_remove_api_keys_tables','008_remove_api_keys_tables.sql','Migration 008_remove_api_keys_tables','2025-08-04 02:29:10',0,'success',NULL),(9,'009_add_visitor_family_support','009_add_visitor_family_support.sql','Migration 009: Add visitor family support','2025-08-06 03:32:03',0,'success',NULL);
/*!40000 ALTER TABLE `migrations` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `notification_rules`
--

DROP TABLE IF EXISTS `notification_rules`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `notification_rules` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `created_by` int(11) NOT NULL,
  `gathering_type_id` int(11) DEFAULT NULL,
  `rule_name` varchar(255) NOT NULL,
  `target_group` enum('regular_attendees','potential_regular_visitors') NOT NULL,
  `trigger_event` enum('attends','misses') NOT NULL,
  `threshold_count` int(11) NOT NULL,
  `timeframe_periods` int(11) NOT NULL DEFAULT 1,
  `is_active` tinyint(1) DEFAULT 1,
  `is_default` tinyint(1) DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_creator` (`created_by`),
  KEY `idx_gathering` (`gathering_type_id`),
  KEY `idx_active` (`is_active`),
  CONSTRAINT `notification_rules_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `notification_rules_ibfk_2` FOREIGN KEY (`gathering_type_id`) REFERENCES `gathering_types` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `notification_rules`
--

LOCK TABLES `notification_rules` WRITE;
/*!40000 ALTER TABLE `notification_rules` DISABLE KEYS */;
/*!40000 ALTER TABLE `notification_rules` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `notifications`
--

DROP TABLE IF EXISTS `notifications`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `notifications` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `rule_id` int(11) DEFAULT NULL,
  `title` varchar(255) NOT NULL,
  `message` text NOT NULL,
  `notification_type` enum('attendance_pattern','visitor_pattern','system') NOT NULL,
  `is_read` tinyint(1) DEFAULT 0,
  `email_sent` tinyint(1) DEFAULT 0,
  `reference_type` enum('individual','visitor','family') DEFAULT NULL,
  `reference_id` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `rule_id` (`rule_id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_type` (`notification_type`),
  KEY `idx_read` (`is_read`),
  KEY `idx_created` (`created_at`),
  CONSTRAINT `notifications_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `notifications_ibfk_2` FOREIGN KEY (`rule_id`) REFERENCES `notification_rules` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `notifications`
--

LOCK TABLES `notifications` WRITE;
/*!40000 ALTER TABLE `notifications` DISABLE KEYS */;
/*!40000 ALTER TABLE `notifications` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `onboarding_progress`
--

DROP TABLE IF EXISTS `onboarding_progress`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `onboarding_progress` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `current_step` varchar(100) DEFAULT 'church_info',
  `completed_steps` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`completed_steps`)),
  `church_info` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`church_info`)),
  `gatherings` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`gatherings`)),
  `csv_upload` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`csv_upload`)),
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_current_step` (`current_step`),
  CONSTRAINT `onboarding_progress_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `onboarding_progress`
--

LOCK TABLES `onboarding_progress` WRITE;
/*!40000 ALTER TABLE `onboarding_progress` DISABLE KEYS */;
/*!40000 ALTER TABLE `onboarding_progress` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `otc_codes`
--

DROP TABLE IF EXISTS `otc_codes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `otc_codes` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `contact_identifier` varchar(255) NOT NULL,
  `contact_type` enum('email','sms') NOT NULL,
  `code` varchar(10) NOT NULL,
  `expires_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `used` tinyint(1) DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_contact_code` (`contact_identifier`,`code`),
  KEY `idx_contact_type` (`contact_type`),
  KEY `idx_expires` (`expires_at`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `otc_codes`
--

LOCK TABLES `otc_codes` WRITE;
/*!40000 ALTER TABLE `otc_codes` DISABLE KEYS */;
/*!40000 ALTER TABLE `otc_codes` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `user_gathering_assignments`
--

DROP TABLE IF EXISTS `user_gathering_assignments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_gathering_assignments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `gathering_type_id` int(11) NOT NULL,
  `assigned_by` int(11) DEFAULT NULL,
  `assigned_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_user_gathering` (`user_id`,`gathering_type_id`),
  KEY `assigned_by` (`assigned_by`),
  KEY `idx_user` (`user_id`),
  KEY `idx_gathering` (`gathering_type_id`),
  CONSTRAINT `user_gathering_assignments_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `user_gathering_assignments_ibfk_2` FOREIGN KEY (`gathering_type_id`) REFERENCES `gathering_types` (`id`) ON DELETE CASCADE,
  CONSTRAINT `user_gathering_assignments_ibfk_3` FOREIGN KEY (`assigned_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `user_gathering_assignments`
--

LOCK TABLES `user_gathering_assignments` WRITE;
/*!40000 ALTER TABLE `user_gathering_assignments` DISABLE KEYS */;
INSERT INTO `user_gathering_assignments` VALUES (1,2,1,2,'2025-08-04 02:29:24'),(2,2,2,2,'2025-08-04 02:29:24'),(4,1,1,1,'2025-08-04 03:06:12'),(5,1,2,1,'2025-08-04 03:06:12'),(6,3,1,1,'2025-08-04 03:06:12'),(7,3,2,1,'2025-08-04 03:06:12'),(8,4,1,1,'2025-08-04 03:06:12'),(9,4,2,1,'2025-08-04 03:06:12');
/*!40000 ALTER TABLE `user_gathering_assignments` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `user_invitations`
--

DROP TABLE IF EXISTS `user_invitations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_invitations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `email` varchar(255) DEFAULT NULL,
  `mobile_number` varchar(20) DEFAULT NULL,
  `primary_contact_method` enum('email','sms') DEFAULT 'email',
  `role` enum('admin','coordinator','attendance_taker') NOT NULL,
  `first_name` varchar(100) DEFAULT NULL,
  `last_name` varchar(100) DEFAULT NULL,
  `invited_by` int(11) NOT NULL,
  `invitation_token` varchar(255) NOT NULL,
  `gathering_assignments` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`gathering_assignments`)),
  `expires_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `accepted` tinyint(1) DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `invitation_token` (`invitation_token`),
  KEY `invited_by` (`invited_by`),
  KEY `idx_email` (`email`),
  KEY `idx_mobile` (`mobile_number`),
  KEY `idx_token` (`invitation_token`),
  KEY `idx_expires` (`expires_at`),
  KEY `idx_accepted` (`accepted`),
  CONSTRAINT `user_invitations_ibfk_1` FOREIGN KEY (`invited_by`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `check_invitation_contact` CHECK (`email` is not null and `email` <> '' or `mobile_number` is not null and `mobile_number` <> '')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `user_invitations`
--

LOCK TABLES `user_invitations` WRITE;
/*!40000 ALTER TABLE `user_invitations` DISABLE KEYS */;
/*!40000 ALTER TABLE `user_invitations` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `email` varchar(255) DEFAULT NULL,
  `mobile_number` varchar(20) DEFAULT NULL,
  `primary_contact_method` enum('email','sms') DEFAULT 'email',
  `role` enum('admin','coordinator','attendance_taker') NOT NULL DEFAULT 'attendance_taker',
  `first_name` varchar(100) DEFAULT NULL,
  `last_name` varchar(100) DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  `is_invited` tinyint(1) DEFAULT 0,
  `first_login_completed` tinyint(1) DEFAULT 0,
  `default_gathering_id` int(11) DEFAULT NULL,
  `email_notifications` tinyint(1) DEFAULT 1,
  `sms_notifications` tinyint(1) DEFAULT 1,
  `notification_frequency` enum('instant','daily','weekly') DEFAULT 'instant',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_email` (`email`),
  UNIQUE KEY `unique_mobile` (`mobile_number`),
  KEY `idx_email` (`email`),
  KEY `idx_mobile` (`mobile_number`),
  KEY `idx_primary_contact` (`primary_contact_method`),
  KEY `idx_role` (`role`),
  KEY `idx_active` (`is_active`),
  KEY `idx_default_gathering` (`default_gathering_id`),
  CONSTRAINT `check_contact_info` CHECK (`email` is not null and `email` <> '' or `mobile_number` is not null and `mobile_number` <> '')
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `users`
--

LOCK TABLES `users` WRITE;
/*!40000 ALTER TABLE `users` DISABLE KEYS */;
INSERT INTO `users` VALUES (1,'admin@church.local',NULL,'email','admin','System','Administrator',1,0,0,NULL,1,1,'instant','2025-08-03 23:05:49','2025-08-03 23:05:49'),(2,'dev@church.local',NULL,'email','admin','Development','Admin',1,0,1,NULL,1,1,'instant','2025-08-04 01:44:26','2025-08-04 01:44:26'),(3,'coord@church.local',NULL,'email','coordinator','Development','Coordinator',1,0,1,NULL,1,1,'instant','2025-08-04 03:05:39','2025-08-04 03:05:39'),(4,'at@church.local',NULL,'email','attendance_taker','Development','Attendance Taker',1,0,1,NULL,1,1,'instant','2025-08-04 03:05:39','2025-08-04 03:05:39');
/*!40000 ALTER TABLE `users` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `visitors`
--

DROP TABLE IF EXISTS `visitors`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `visitors` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `session_id` int(11) NOT NULL,
  `name` varchar(255) NOT NULL,
  `visitor_type` enum('potential_regular','temporary_other') NOT NULL,
  `visitor_family_group` varchar(255) DEFAULT NULL,
  `notes` text DEFAULT NULL,
  `last_attended` date DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_session` (`session_id`),
  KEY `idx_type` (`visitor_type`),
  KEY `idx_name` (`name`),
  KEY `idx_family_group` (`visitor_family_group`),
  KEY `idx_last_attended` (`last_attended`),
  CONSTRAINT `visitors_ibfk_1` FOREIGN KEY (`session_id`) REFERENCES `attendance_sessions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `visitors`
--

LOCK TABLES `visitors` WRITE;
/*!40000 ALTER TABLE `visitors` DISABLE KEYS */;
INSERT INTO `visitors` VALUES (1,1,'Jackie Chan','potential_regular',NULL,NULL,'2025-07-27','2025-08-04 03:14:39','2025-08-04 03:14:39'),(2,35,'Smitty McSmitface','potential_regular','family_35_1754340463092',NULL,'2025-07-06','2025-08-04 20:47:43','2025-08-04 20:47:43'),(3,35,'Judy McSmitface','potential_regular','family_35_1754340463092',NULL,'2025-07-06','2025-08-04 20:47:43','2025-08-04 20:47:43'),(4,41,'Judy McSmitface','potential_regular',NULL,NULL,'2025-07-13','2025-08-04 20:53:11','2025-08-04 20:53:11'),(5,41,'Smitty McSmitface','potential_regular',NULL,NULL,'2025-07-13','2025-08-04 20:53:33','2025-08-04 20:53:33');
/*!40000 ALTER TABLE `visitors` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2025-08-06 23:30:27
